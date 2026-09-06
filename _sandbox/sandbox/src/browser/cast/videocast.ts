import { type ChildProcess, spawn } from "node:child_process";
import { errorMessage } from "@intentic/base/errors";
import type { Display } from "./display.js";

/* THE BROWSER AS VIDEO, grabbed off its X display instead of out of one page's compositor.
 *
 * WHAT THIS REPLACES AND WHY. The old picture was `Page.startScreencast`: whole JPEG images, base64'd into
 * JSON, one per change. A 1280x800 JPEG is 150-250 kB before base64 adds a third, so smoothness was
 * unaffordable and the stream was tuned around never sending frames — which is what made taking the wheel feel
 * like operating the page by post. Measured against this pipeline on a settled page, three SECONDS of H.264 is
 * ~23 kB: less than a tenth of ONE of those JPEGs. An inter-frame codec is simply the right instrument for a
 * picture that mostly does not change, and 30fps costs less than the old stream's occasional stills did.
 *
 * It also photographs the right thing. A compositor surface is the page and nothing else: no cursor (Chromium
 * draws that above it, in the window), no native <select> menu, no autofill drop-down, no file picker, no
 * permission prompt, no browser chrome. All of those are on the DISPLAY, so all of them are in this picture —
 * and because xinput.ts drives the same display, all of them are operable. That is the whole design: one
 * coordinate space, containing everything the browser actually shows.
 *
 * ONE ENCODER PER VIEWER, deliberately, rather than one per browser fanned out to whoever is watching. It costs
 * a second encode in the rare case that two people watch one browser, and it buys the thing that would
 * otherwise need real machinery: a viewer's stream always BEGINS at a keyframe, so there is no join problem, no
 * keyframe request path, and no shared decoder state to get wrong. Pausing is killing it; resuming is starting
 * another.
 */

// 30 is where a page stops looking stepped, and the encode costs about half what 60 does for a difference
// almost nobody can see on a document.
const FPS = 30;
/* A recovery point every two seconds. With one encoder per viewer the FIRST frame is always a keyframe, so
 * this is not about joining — it is about a decoder that dropped something being able to right itself without
 * the socket being torn down and rebuilt. */
const KEYFRAME_INTERVAL = FPS * 2;
/* Quality, and a ceiling on what a pathological page can cost. CRF 24 is visually clean for text at this size;
 * the ceiling exists because a video background or a full-screen canvas animation would otherwise be allowed
 * to fill whatever the tunnel has. */
const CRF = 24;
const MAX_RATE = "6M";
const BUF_SIZE = "2M";

// One access unit — one frame — as it goes to a viewer. `key` is what lets the client tell VideoDecoder whether
// this chunk can start a stream, which is the only thing it cannot work out for itself.
export interface VideoFrame {
    readonly bytes: Buffer;
    readonly key: boolean;
}

export interface Videocast {
    readonly stop: () => void;
}

/* The tag bytes a coded frame goes out under, continuing screencast.ts's table (0 jpeg, 1 webp, 2 svg) so ONE
 * socket carries pictures of every kind and the client reads the first byte to know which. Keyframe and delta
 * are separate tags rather than a flag inside the payload, because that single bit is the only thing a
 * VideoDecoder cannot work out for itself, and a tag is where the client is already looking. */
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
    /* The codec string the browser's decoder has to be configured with, READ OUT OF THE STREAM rather than
     * written down here, and reported once the first keyframe arrives.
     *
     * Hardcoding it is the obvious thing and it is wrong. The string encodes profile, constraint flags and
     * level exactly as the sequence parameter set states them, and the flags in particular are x264's business:
     * asking for `-profile:v baseline` at 1280x880 produces `avc1.42C028` on the build this image pins, where
     * the plausible guess is `42E0`. A decoder configured with a string that disagrees with the bitstream is a
     * black picture and no error worth reading — and the disagreement would only appear on whichever ffmpeg a
     * future rebuild happened to install. The SPS is right in front of us; there is no reason to guess. */
    readonly onCodec: (codec: string) => void;
    readonly onExit: (reason: string) => void;
}

/* ANNEX-B, SPLIT WHERE FFMPEG IS ASKED TO MARK IT.
 *
 * H.264 out of a raw muxer is a run of NAL units separated by start codes, with nothing saying where one frame
 * ends and the next begins — a client would have to parse slice headers to find out. So ffmpeg is asked to
 * insert an ACCESS UNIT DELIMITER before every frame (`h264_metadata=aud=insert`), and the boundary becomes a
 * byte pattern this can scan for. One WebSocket message is then exactly one frame, and the browser side does no
 * bitstream parsing at all.
 *
 * A NAL's type is the low five bits of the byte after the start code: 9 is the delimiter, 5 an IDR slice (the
 * keyframe), 7 and 8 the parameter sets that precede one. */
const NAL_AUD = 9;
const NAL_IDR = 5;
const NAL_SPS = 7;

// Where each start code begins, and the type of the NAL that follows it. Both 3- and 4-byte start codes occur
// in one stream (x264 uses 4 for parameter sets and delimiters, 3 for slices), so both are matched.
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

/* Cut a buffer into whole access units, and say what is left over. Everything before the FIRST delimiter is
 * dropped rather than emitted: it is the tail of a frame whose beginning we never saw, which a decoder cannot
 * use and which is only ever seen at the very start of a stream. */
export const splitAccessUnits = (buffer: Buffer): { readonly units: readonly VideoFrame[]; readonly rest: Buffer } => {
    const starts = nalStarts(buffer);
    const delimiters = starts.filter((nal) => nal.type === NAL_AUD).map((nal) => nal.at);
    if (delimiters.length < 2) {
        // Not a whole unit yet: without a SECOND delimiter there is no proof the first one's frame has ended.
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

/* The `avc1.PPCCLL` string for whatever this access unit's parameter set says it is: profile_idc, the
 * constraint-flag byte and level_idc, which are the three bytes immediately after the SPS NAL header. Undefined
 * for a unit carrying no SPS, which is every unit that is not a keyframe. */
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

/* Grab `display` and call `onFrame` with each encoded frame.
 *
 * `-nostdin` is not tidiness: without it ffmpeg reads the daemon's own stdin, and in a process whose stdin is a
 * pipe nobody writes to, it blocks before it has opened the display at all — a capture that produces nothing,
 * reports nothing, and exits only when killed.
 *
 * `-draw_mouse 1` is what puts the pointer in the picture. It is the X server's real cursor, at the position
 * xinput.ts actually moved it to, in the shape Chromium gave it, so a link is a hand and a text field is an
 * I-beam with nothing here having to ask the page what it would have drawn. */
export const startVideocast = (display: Display, handlers: VideocastHandlers): Videocast => {
    // What arrived mid-frame and has to wait for the rest of it. Annotated rather than inferred: `Buffer.alloc`
    // narrows to a plain ArrayBuffer, and a chunk off a socket may be backed by any of them.
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
            // The delimiter this module splits on, and parameter sets repeated at every keyframe so a decoder
            // that lost its way can recover from the next one instead of only from the first.
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
                    // Before the frame, always: the client cannot decode anything until its decoder is
                    // configured, and the frame carrying the parameter sets is the first one it will be given.
                    announced = true;
                    handlers.onCodec(codec);
                }
            }
            handlers.onFrame(unit);
        }
    });
    // ffmpeg's own complaint, which is the only thing that says WHY a capture produced nothing — a display that
    // went away, a codec the build lacks. Kept to one line: it is a diagnostic, not a log stream.
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
