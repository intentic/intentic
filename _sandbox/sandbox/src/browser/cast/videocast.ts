import { type ChildProcess, spawn } from "node:child_process";
import { errorMessage } from "@intentic/base/errors";
import type { Display } from "./display.js";

// Grabs the browser as video off its X display, not one page's compositor, since an inter-frame codec suits a picture
// that mostly doesn't change. Captures everything on the display (cursor, menus, file pickers, chrome) in one
// coordinate space xinput.ts also drives. One encoder per viewer: every stream begins at a keyframe, no join problem.

// 30fps is where a page stops looking stepped; 60 costs about twice as much for a barely visible difference.
const FPS = 30;
// Recovery point every two seconds, so a decoder that dropped something can recover without a socket rebuild.
const KEYFRAME_INTERVAL = FPS * 2;
// CRF 24 is visually clean for text at this size; the rate ceiling bounds what a pathological page can cost.
const CRF = 24;
const MAX_RATE = "6M";
const BUF_SIZE = "2M";

// One access unit (frame) to a viewer; `key` tells VideoDecoder whether this chunk can start a stream, the one thing it
// can't work out itself.
export interface VideoFrame {
    readonly bytes: Buffer;
    readonly key: boolean;
}

export interface Videocast {
    readonly stop: () => void;
}

// Tags continue screencast.ts's table so one socket carries every kind; decoders can't infer that bit.
export const FRAME_H264_KEY = 3;
export const FRAME_H264_DELTA = 4;

// A coded frame as it goes on the wire: one tag byte, then the access unit. The mirror of encodeFrame.
export const encodeVideo = (frame: VideoFrame): Uint8Array<ArrayBuffer> => {
    const wire = new Uint8Array(frame.bytes.byteLength + 1);
    wire[0] = frame.key ? FRAME_H264_KEY : FRAME_H264_DELTA;
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

// `-nostdin` avoids ffmpeg blocking on the daemon's own unwritten stdin pipe before it even opens the display.
// `-draw_mouse 1` draws the X server's real cursor at xinput.ts's actual position, in Chromium's own shape.
export const startVideocast = (display: Display, handlers: VideocastHandlers): Videocast => {
    // Bytes arrived mid-frame, waiting for the rest; typed since a socket chunk may back any ArrayBufferLike.
    let pending: Buffer = Buffer.alloc(0);
    let stopped = false;
    let announced = false;
    const child: ChildProcess = spawn(
        "ffmpeg",
        [
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "x11grab",
            "-draw_mouse",
            "1",
            "-video_size",
            `${display.width}x${display.height}`,
            "-framerate",
            String(FPS),
            "-i",
            `${display.name}.0`,
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
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped) {
            return;
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        const { units, rest } = splitAccessUnits(pending);
        pending = rest;
        for (const unit of units) {
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
