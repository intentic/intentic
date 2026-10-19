import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import { runCheck } from "../../../workload/run-check.js";

// A video seen as a picture: the frame its tile shows, and the box it plays in, both read with ffmpeg where the sandbox
// has it (the browser pack brings it). Without ffmpeg the thumb route refuses a video as it refuses an SVG, and the
// guest seeks a <video> element instead.

// What ffmpeg is asked to open; the formats the editor files under video (fileFormat.ts), which ffmpeg all reads.
const VIDEOS: ReadonlySet<string> = new Set([
    ".mp4",
    ".m4v",
    ".webm",
    ".ogv",
    ".mov",
    ".3gp",
    ".3g2",
    ".mkv",
    ".avi",
    ".wmv",
    ".mpg",
    ".mpeg",
    ".flv",
]);

export const isVideo = (path: string): boolean => VIDEOS.has(extname(path).toLowerCase());

// One probe or one frame is a fraction of a second; past this the file is not worth waiting on.
const PROBE_TIMEOUT_MS = 10_000;
const FRAME_TIMEOUT_MS = 15_000;
// ffprobe's JSON for one stream and the container is a few hundred bytes; a bound, not a budget.
const CAPTURE_BYTES = 64 * 1024;

let present: Promise<boolean> | undefined;

/** Whether ffmpeg and ffprobe both run here; asked once, since installing them rebuilds the sandbox and restarts this. */
export const videoToolsPresent = (): Promise<boolean> => {
    present ??= (async () => {
        const answers = await Promise.all(
            ["ffmpeg", "ffprobe"].map((tool) =>
                runCheck({
                    argv: [tool, "-hide_banner", "-version"],
                    timeoutMs: PROBE_TIMEOUT_MS,
                    workload: { class: "command" },
                    kind: "media-probe",
                    captureBytes: CAPTURE_BYTES,
                }),
            ),
        );
        return answers.every((ran) => ran.exitCode === 0);
    })();
    return present;
};

export interface VideoFacts {
    // The box it plays in, turned the way a phone's rotation tag says to show it.
    readonly width: number;
    readonly height: number;
    // Seconds; undefined where the container does not say (a live capture cut short).
    readonly duration: number | undefined;
}

interface ProbeAnswer {
    readonly streams?: readonly {
        readonly width?: number;
        readonly height?: number;
        readonly tags?: { readonly rotate?: string };
        readonly side_data_list?: readonly { readonly rotation?: number }[];
    }[];
    readonly format?: { readonly duration?: string };
}

// A quarter turn either way swaps the box: a portrait phone clip is stored landscape with a rotation beside it.
const quarterTurned = (stream: NonNullable<ProbeAnswer["streams"]>[number]): boolean => {
    const rotation = stream.side_data_list?.find((side) => side.rotation !== undefined)?.rotation ?? Number(stream.tags?.rotate ?? 0);
    return Math.abs(Math.round(rotation / 90)) % 2 === 1;
};

/** Parses ffprobe's JSON for the first video stream; undefined when it names no stream with a size. */
export const parseVideoFacts = (json: string): VideoFacts | undefined => {
    let answer: ProbeAnswer;
    try {
        // SAFETY: every field read below is optional and checked for type and range before it is used.
        answer = JSON.parse(json) as ProbeAnswer;
    } catch {
        // allow(silent-catch): ffprobe printing something other than JSON is a file it could not read, which undefined says
        return undefined;
    }
    const stream = answer.streams?.[0];
    if (stream?.width === undefined || stream.height === undefined || stream.width <= 0 || stream.height <= 0) {
        return undefined;
    }
    const duration = Number(answer.format?.duration);
    const turned = quarterTurned(stream);
    return {
        width: turned ? stream.height : stream.width,
        height: turned ? stream.width : stream.height,
        duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    };
};

/** The first video stream's box and the container's length; undefined when ffprobe cannot read the file. */
export const videoFacts = async (target: string): Promise<VideoFacts | undefined> => {
    const ran = await runCheck({
        argv: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration",
            "-of",
            "json",
            target,
        ],
        timeoutMs: PROBE_TIMEOUT_MS,
        workload: { class: "command" },
        kind: "media-probe",
        captureBytes: CAPTURE_BYTES,
    });
    return ran.exitCode === 0 ? parseVideoFacts(ran.stdout) : undefined;
};

// Where a poster is looked for, as fractions of the running time, in the order GNOME's video thumbnailer tries them: a
// third in is past a title card and a fade, and the rest are there for a video whose third is a blank.
const CANDIDATES = [1 / 3, 2 / 3, 0.1, 0.9, 0.5] as const;
// A frame whose grey levels spread less than this is a flat field (a fade to white, a black slate): the same bar that
// thumbnailer sets, a variance of 256.
const BORING_STDEV = 16;
// As large as the largest rendition is cut from (PICTURE_EDGES), so the rendition's own resize sets the quality.
const FRAME_BOX = 2048;

// One frame at `at` seconds as a PNG, or undefined when ffmpeg cannot reach it. Written to a file beside the cache
// rather than piped, since the daemon's one command door reads output as text.
const frameAt = async (target: string, at: number, scratch: string): Promise<Buffer | undefined> => {
    const out = join(scratch, `frame-${randomBytes(6).toString("hex")}.png`);
    try {
        const ran = await runCheck({
            argv: [
                "ffmpeg",
                "-v",
                "error",
                "-nostdin",
                "-y",
                // Before the input, so ffmpeg seeks the container rather than decoding its way there.
                "-ss",
                at.toFixed(3),
                "-i",
                target,
                "-an",
                "-sn",
                "-frames:v",
                "1",
                "-vf",
                `scale=${FRAME_BOX}:${FRAME_BOX}:force_original_aspect_ratio=decrease`,
                "-c:v",
                "png",
                out,
            ],
            timeoutMs: FRAME_TIMEOUT_MS,
            workload: { class: "command" },
            kind: "media-probe",
            captureBytes: CAPTURE_BYTES,
        });
        if (ran.exitCode !== 0) {
            return undefined;
        }
        // Read into memory before the file goes: sharp opens a path lazily, after the finally below has run.
        return await readFile(out);
    } finally {
        // allow(silent-catch): a scratch frame already gone is the state this wants
        await rm(out, { force: true }).catch(() => undefined);
    }
};

const spreadOf = async (frame: Buffer): Promise<number> => {
    const stats = await sharp(frame).greyscale().stats();
    return stats.channels[0]?.stdev ?? 0;
};

/**
 * The frame a video's tile shows, as a PNG: the first candidate with something in it, else the busiest one tried.
 * Undefined when ffmpeg can read none of them. `scratch` is a directory the frame may be written through.
 */
export const videoPoster = async (target: string, scratch: string): Promise<Buffer | undefined> => {
    const facts = await videoFacts(target);
    if (facts === undefined) {
        return undefined;
    }
    // A container that does not say how long it runs still has a first frame.
    const times = facts.duration === undefined ? [0] : CANDIDATES.map((fraction) => facts.duration! * fraction);
    let best: { readonly frame: Buffer; readonly spread: number } | undefined;
    for (const at of times) {
        const frame = await frameAt(target, at, scratch);
        if (frame === undefined) {
            continue;
        }
        const spread = await spreadOf(frame);
        if (spread >= BORING_STDEV) {
            return frame;
        }
        if (best === undefined || spread > best.spread) {
            best = { frame, spread };
        }
    }
    return best?.frame;
};
