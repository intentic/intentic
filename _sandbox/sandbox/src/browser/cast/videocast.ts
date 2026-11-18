import type { ChildProcess } from "node:child_process";
import { errorMessage } from "@intentic/base/errors";
import { spawnAs } from "../../workload/workload-class.js";
import type { Region } from "./region.js";

// Grabs the browser as video off its X display, not one page's compositor, since an inter-frame codec suits a picture
// that mostly doesn't change. Grabs the page's viewport region (region.ts): everything Chromium draws there, a native
// <select>, a context menu, a popup window placed over the page, in one coordinate space xinput.ts also drives; the
// browser's own toolbar stays out, since the client draws its own. One encoder per viewer: every stream begins at a
// keyframe, no join problem.

// 30fps is where a page stops looking stepped; 60 costs about twice as much for a barely visible difference.
const FPS = 30;
// A keyframe once a minute, as a backstop only: every stream opens on one (a resize, a resume, another window), and a
// viewer that falls behind or loses its decoder is given one by a restart (frameGate). The rate cap squeezes each
// keyframe and the next second or so of frames refines it; at one a second, a large still page never settled, so the
// still never came (stills.ts) and the picture stayed soft at ~7 Mbit/s (measured 2026-11-18, 1800×1100 and up).
const KEYFRAME_INTERVAL = FPS * 60;
// CRF 24 is visually clean for text at this size; the rate ceiling bounds what a pathological page can cost.
const CRF = 24;
const MAX_RATE = "6M";
const BUF_SIZE = "2M";

// A still that has not come back by then is given up on; the next settle asks again.
const STILL_TIMEOUT_MS = 3000;

// One access unit (frame) to a viewer; `key` tells VideoDecoder whether this chunk can start a stream, the one thing it
// can't work out itself.
export interface VideoFrame {
    readonly bytes: Buffer;
    readonly key: boolean;
}

export interface Videocast {
    readonly stop: () => void;
}

// Tags continue screencast.ts's table so one socket carries every kind; decoders can't infer that bit. The quiet pair
// says the frame shows nothing a still the client holds does not (stills.ts): decoded, to keep the stream whole, but
// not painted over the sharper picture.
export const FRAME_H264_KEY = 3;
export const FRAME_H264_DELTA = 4;
export const FRAME_H264_KEY_QUIET = 5;
export const FRAME_H264_DELTA_QUIET = 6;

// A coded frame as it goes on the wire: one tag byte, then the access unit. The mirror of encodeFrame.
export const encodeVideo = (frame: VideoFrame, quiet = false): Uint8Array<ArrayBuffer> => {
    const wire = new Uint8Array(frame.bytes.byteLength + 1);
    wire[0] = frame.key ? (quiet ? FRAME_H264_KEY_QUIET : FRAME_H264_KEY) : quiet ? FRAME_H264_DELTA_QUIET : FRAME_H264_DELTA;
    wire.set(frame.bytes, 1);
    return wire;
};

export interface VideocastHandlers {
    readonly onFrame: (frame: VideoFrame) => void;
    // Codec string is read from the stream, not hardcoded: x264's actual flags can differ from a plausible guess.
    readonly onCodec: (codec: string) => void;
    readonly onExit: (reason: string) => void;
}

// ffmpeg inserts an access-unit delimiter per frame, so one WebSocket message is exactly one frame.
const NAL_AUD = 9;
const NAL_IDR = 5;
const NAL_SPS = 7;

// Where each start code begins and the type of the NAL after it; both 3- and 4-byte codes occur in one stream, so both
// are matched.
const nalStarts = (buffer: Buffer): readonly { readonly at: number; readonly type: number }[] => {
    const found: { at: number; type: number }[] = [];
    for (let index = 0; index + 3 < buffer.length; index++) {
        if (buffer[index] !== 0 || buffer[index + 1] !== 0) {
            continue;
        }
        const three = buffer[index + 2] === 1;
        const four = buffer[index + 2] === 0 && buffer[index + 3] === 1;
        if (!three && !four) {
            continue;
        }
        const header = buffer[four ? index + 4 : index + 3];
        if (header === undefined) {
            break;
        }
        found.push({ at: index, type: header & 0x1f });
        // Past the start code, so the zeros inside it are never re-read as the head of another one.
        index += four ? 3 : 2;
    }
    return found;
};

// Cuts a buffer into whole access units, plus what's left over. Bytes before the first delimiter are dropped, not
// emitted: the tail of a frame whose start we never saw.
export const splitAccessUnits = (buffer: Buffer): { readonly units: readonly VideoFrame[]; readonly rest: Buffer } => {
    const starts = nalStarts(buffer);
    const delimiters = starts.filter((nal) => nal.type === NAL_AUD).map((nal) => nal.at);
    if (delimiters.length < 2) {
        // Not a whole unit yet: without a second delimiter, nothing proves the first frame has ended.
        return { units: [], rest: buffer };
    }
    const units: VideoFrame[] = [];
    for (let index = 0; index + 1 < delimiters.length; index++) {
        const from = delimiters[index]!;
        const to = delimiters[index + 1]!;
        units.push({
            bytes: buffer.subarray(from, to),
            key: starts.some((nal) => nal.at >= from && nal.at < to && nal.type === NAL_IDR),
        });
    }
    return { units, rest: buffer.subarray(delimiters.at(-1)!) };
};

// Builds the `avc1.PPCCLL` string from the three bytes after the SPS NAL header (profile_idc, constraint flags,
// level_idc); undefined for a unit with no SPS, i.e. any non-keyframe.
export const readCodec = (unit: Buffer): string | undefined => {
    const sps = nalStarts(unit).find((nal) => nal.type === NAL_SPS);
    if (sps === undefined) {
        return undefined;
    }
    // Past the start code (3 or 4 bytes) and past the one-byte NAL header.
    const at = unit[sps.at + 2] === 1 ? sps.at + 4 : sps.at + 5;
    const bytes = [unit[at], unit[at + 1], unit[at + 2]];
    if (bytes.some((byte) => byte === undefined)) {
        return undefined;
    }
    return `avc1.${bytes
        .map((byte) => byte!.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()}`;
};

// The encoder's command line for one region: x11grab off the display, H.264 on stdout. `-nostdin` avoids ffmpeg blocking
// on the daemon's own unwritten stdin pipe before it even opens the display. `-draw_mouse 0`: the pointer is the
// client's own, drawn where the owner's hand is rather than a round trip behind it; the shape comes from the page
// (screencast.ts's cursorReporter).
const encoderArgs = (display: { readonly name: string }, region: Region): string[] => [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-video_size",
    `${region.width}x${region.height}`,
    "-framerate",
    String(FPS),
    "-i",
    `${display.name}.0+${region.x},${region.y}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-level:v",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    String(CRF),
    "-maxrate",
    MAX_RATE,
    "-bufsize",
    BUF_SIZE,
    "-g",
    String(KEYFRAME_INTERVAL),
    // Delimiter this module splits on; parameter sets repeat at every keyframe so any one can help recovery.
    "-bsf:v",
    "h264_metadata=aud=insert,dump_extra=freq=keyframe",
    "-f",
    "h264",
    "pipe:1",
];

export const startVideocast = (display: { readonly name: string }, region: Region, handlers: VideocastHandlers): Videocast => {
    // Bytes arrived mid-frame, waiting for the rest; typed since a socket chunk may back any ArrayBufferLike.
    let pending: Buffer = Buffer.alloc(0);
    let stopped = false;
    let announced = false;
    const child: ChildProcess = spawnAs({ class: "service" }, "ffmpeg", encoderArgs(display, region), { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped) {
            return;
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        const { units, rest } = splitAccessUnits(pending);
        pending = rest;
        for (const unit of units) {
            // Stopped by a frame of this same chunk (a restart asked from onFrame): the rest belong to a stream gone.
            if (stopped) {
                return;
            }
            if (!announced) {
                const codec = readCodec(unit.bytes);
                if (codec !== undefined) {
                    // Codec announced before the frame, always, since the client can't decode until its decoder is
                    // configured.
                    announced = true;
                    handlers.onCodec(codec);
                }
            }
            handlers.onFrame(unit);
        }
    });
    // ffmpeg's own complaint, the only clue why a capture produced nothing; kept to one line, not a log.
    let complaint = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        complaint = `${complaint}${String(chunk)}`.slice(-500);
    });
    child.on("error", (error) => {
        // ENOENT: ffmpeg rides the browser pack, so a sandbox without it has none. The caller falls back.
        handlers.onExit(errorMessage(error));
    });
    child.on("exit", (code) => {
        if (!stopped) {
            handlers.onExit(complaint.trim() === "" ? `ffmpeg exited (${code})` : complaint.trim());
        }
    });

    return {
        stop: () => {
            stopped = true;
            try {
                child.kill("SIGKILL");
            } catch {
                // already gone, which is the outcome asked for
            }
        },
    };
};

// Unsent bytes a viewer's socket may hold before frames are dropped until a fresh keyframe; a second of video at the
// encoder's ceiling, so a link that keeps up never sees it.
export const BACKLOG_LIMIT = 256 * 1024;
// The least time between two restarts the gate asks for: a link that stays slower than the picture is offered a fresh
// keyframe this often, rather than an encoder restarted on every frame that finds the socket drained.
const RESTART_MIN_MS = 1000;

export interface FrameGate {
    // Whether this frame goes to the viewer: not while its socket holds a backlog, nor after one until a keyframe.
    readonly admit: (frame: VideoFrame) => boolean;
    // The viewer lost the stream (its decoder refused a frame): nothing more goes until a fresh keyframe, which a
    // restart brings rather than the next periodic one.
    readonly askKey: () => void;
    // A fresh stream started, opening on a keyframe.
    readonly started: () => void;
    readonly stop: () => void;
}

// What every viewer of a videocast shares (live-view.ts, desktop-view.ts): frames are dropped while the socket is
// slower than the picture, and once it drains the stream is restarted for a keyframe to resume on, since the periodic
// one is a minute away (KEYFRAME_INTERVAL). `restart` starts a fresh stream and calls `started`.
export const frameGate = (options: { readonly backlog: () => number; readonly restart: () => void }): FrameGate => {
    let dropping = false;
    let startedAt = 0;
    let timer: NodeJS.Timeout | undefined;

    // Never from inside the frame's own delivery: the restart stops the stream that frame came from.
    const restartSoon = (): void => {
        if (timer !== undefined) {
            return;
        }
        timer = setTimeout(
            () => {
                timer = undefined;
                if (dropping) {
                    options.restart();
                }
            },
            Math.max(0, startedAt + RESTART_MIN_MS - Date.now()),
        );
    };

    return {
        admit: (frame) => {
            const backlog = options.backlog();
            if (!dropping) {
                dropping = backlog > BACKLOG_LIMIT;
                return !dropping;
            }
            if (backlog > BACKLOG_LIMIT) {
                return false;
            }
            if (frame.key) {
                dropping = false;
                return true;
            }
            restartSoon();
            return false;
        },
        askKey: () => {
            dropping = true;
            restartSoon();
        },
        started: () => {
            dropping = false;
            startedAt = Date.now();
            clearTimeout(timer);
            timer = undefined;
        },
        stop: () => {
            clearTimeout(timer);
            timer = undefined;
        },
    };
};

// One sharp picture of `region` off the display, as WebP at `quality`: the still the video path lays over its picture
// (stills.ts). Off the display rather than the page (CDP's Page.captureScreenshot) because the display is what the video
// shows: Chromium's own bubbles and menus drawn over the page (translate, a permission prompt, a password offer, a
// <select>) are in it, where a photograph of the page alone left them out, and the picture blinked between the two
// whenever a still came and went (2026-10-08). Reading the display also re-renders nothing, so no frame of the video is
// the still's own echo. Undefined when ffmpeg could not grab it (gone, no libwebp, a display that died).
export const grabStill = (display: { readonly name: string }, region: Region, quality: number): Promise<Buffer | undefined> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let child: ChildProcess;
        try {
            child = spawnAs(
                { class: "service" },
                "ffmpeg",
                [
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-f",
                    "x11grab",
                    "-draw_mouse",
                    "0",
                    "-video_size",
                    `${region.width}x${region.height}`,
                    "-i",
                    `${display.name}.0+${region.x},${region.y}`,
                    "-frames:v",
                    "1",
                    "-c:v",
                    "libwebp",
                    "-quality",
                    String(quality),
                    "-f",
                    "webp",
                    "pipe:1",
                ],
                { stdio: ["ignore", "pipe", "ignore"] },
            );
        } catch {
            // allow(silent-catch): no ffmpeg to start is a still not taken; the video stands alone.
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), STILL_TIMEOUT_MS);
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : undefined);
        });
    });
