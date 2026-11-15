import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { runCheck } from "../../../workload/run-check.js";
import { statePath } from "../../../state-paths.js";
import { contentTypeForPath } from "../workspace-files-download.js";
import { isVideo, videoToolsPresent } from "./workspace-video.js";

// A recording or a video the reader's browser can't decode, made playable: ffmpeg renders it once into an MP4 box every
// engine plays, and the rendition is kept per version of the file so a reopen streams it at once. A recording (AIFF and
// CAF outside Safari, WMA, AMR, a WAV holding ADPCM or 64-bit floats) becomes AAC. A video (AVI, WMV, FLV, MPEG, a
// Matroska or a phone's HEVC outside the browsers that decode it) becomes H.264 and AAC; one whose picture is already
// H.264 is only moved into the new box, which takes seconds however long it runs. The player asks for it only after the
// original failed to decode (MediaViewer), so a file the browser plays is never touched.

// What this renders: anything the media route types as audio, which is the set the editor files under audio too, and the
// formats the editor files under video.
const isAudio = (path: string): boolean => contentTypeForPath(path).startsWith("audio/");

// An hour of speech renders in well under a minute; a video is re-encoded at a fraction of real time on a few cores.
// Past these the file isn't one a person is waiting on.
const AUDIO_TIMEOUT_MS = 5 * 60_000;
const VIDEO_TIMEOUT_MS = 30 * 60_000;
// How long one request waits for a rendition before answering that it is still being made (503, which the player asks
// again after): a proxy in front of the daemon (Cloudflare's is 100 s) drops a request held longer, and the render it
// started goes on without it.
const READY_WAIT_MS = 20_000;
// ffmpeg's own complaints are a line or two; a bound, not a budget.
const CAPTURE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
// Renditions kept before the cache is emptied. A recording is about 1.4 MB a minute and a video tens of megabytes, so
// this bounds it at a few gigabytes, and the price of forgetting is one render.
const MAX_CACHED = 64;
// The largest box a re-encoded picture keeps, either way up: what a viewer pane shows, and a 4K source re-encoded in
// full would take as long again for nothing the reader sees.
const VIDEO_EDGE = 1920;

interface Rendering {
    // Bumped when its encoding changes, so renditions made at old settings are not served.
    readonly encoding: string;
    readonly extension: string;
    readonly type: string;
    readonly timeoutMs: number;
    // ffmpeg's arguments between its input and its output, as ways to try in order: the first that ffmpeg finishes wins.
    readonly attempts: (target: string) => Promise<readonly (readonly string[])[]>;
}

const AUDIO: Rendering = {
    encoding: "aac-192k-v1",
    extension: "m4a",
    type: "audio/mp4",
    timeoutMs: AUDIO_TIMEOUT_MS,
    // The first audio stream only: no cover art (an attached picture would make the box a video), no subtitles.
    attempts: async () => [["-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "192k"]],
};

// Whether the first video stream is a picture every browser decodes as it stands: H.264 in 8-bit 4:2:0. Asked so a file
// that only came in a box the browser refuses (an AVI, a Matroska) is moved rather than re-encoded.
const decodesAsItStands = async (target: string): Promise<boolean> => {
    const ran = await runCheck({
        argv: ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", target],
        timeoutMs: PROBE_TIMEOUT_MS,
        workload: { class: "command" },
        kind: "media-probe",
        captureBytes: CAPTURE_BYTES,
    });
    return ran.exitCode === 0 && /^h264,(yuv420p|yuvj420p)$/.test(ran.stdout.trim());
};

// The first picture and, where there is one, the first sound: no subtitles or data streams an MP4 can't carry.
const VIDEO_STREAMS = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"] as const;
const VIDEO_SOUND = ["-c:a", "aac", "-b:a", "160k"] as const;
const REENCODED = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    // 8-bit 4:2:0, what every decoder takes; a 10-bit or 4:4:4 source is the usual reason a browser refuses one.
    "-pix_fmt",
    "yuv420p",
    // Within the box, never enlarged, both sides even, as 4:2:0 needs.
    "-vf",
    `scale=w='min(${VIDEO_EDGE},iw)':h='min(${VIDEO_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
] as const;

const VIDEO: Rendering = {
    encoding: "h264-aac-v1",
    extension: "mp4",
    type: "video/mp4",
    timeoutMs: VIDEO_TIMEOUT_MS,
    // A picture that decodes as it stands is moved first; a box that can't hand it over whole (an AVI without timestamps)
    // falls back to the re-encode every other picture gets.
    attempts: async (target) => [
        ...((await decodesAsItStands(target)) ? [[...VIDEO_STREAMS, "-c:v", "copy", ...VIDEO_SOUND]] : []),
        [...VIDEO_STREAMS, ...REENCODED, ...VIDEO_SOUND],
    ],
};

const renderingFor = (path: string): Rendering | undefined => (isVideo(path) ? VIDEO : isAudio(path) ? AUDIO : undefined);

const cacheDir = (root: string): string => statePath(root, ".intentic/local/cache/", "playable");

// Renders in flight, keyed by their cache file: a player's first range requests all land on one ffmpeg.
const inFlight = new SingleFlight<string, string | undefined>();

// Empties the cache once it holds more than it should, the thumbnails' rule (workspace-thumbnail.ts): a cache may forget.
// Finished renditions only: a video can take minutes to make, and another render's half-written file must survive it.
const sweep = async (dir: string): Promise<void> => {
    const held = (await readdir(dir).catch((): string[] => [])).filter((name) => !name.endsWith(".part"));
    if (held.length > MAX_CACHED) {
        // allow(silent-catch): a rendition that cannot be removed just stays until the next render tries again
        await Promise.all(held.map((name) => rm(join(dir, name), { force: true }).catch(() => undefined)));
    }
};

// One way of making it: ffmpeg writes beside the final name, so a second reader never streams a half-made file, and the
// result is moved into place whole.
const attempt = async (target: string, file: string, args: readonly string[], timeoutMs: number): Promise<boolean> => {
    const partial = `${file}.${randomBytes(6).toString("hex")}.part`;
    const ran = await runCheck({
        argv: [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-i",
            target,
            ...args,
            // The index up front, so the player can start and seek before it has read to the end.
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            partial,
        ],
        timeoutMs,
        workload: { class: "command" },
        kind: "media-probe",
        captureBytes: CAPTURE_BYTES,
    });
    if (ran.exitCode !== 0) {
        // allow(silent-catch): the scratch file may never have been written
        await rm(partial, { force: true }).catch(() => undefined);
        return false;
    }
    await rename(partial, file);
    return true;
};

const render = async (target: string, file: string, rendering: Rendering): Promise<string | undefined> => {
    const dir = join(file, "..");
    await sweep(dir);
    await mkdir(dir, { recursive: true });
    for (const args of await rendering.attempts(target)) {
        if (await attempt(target, file, args, rendering.timeoutMs)) {
            return file;
        }
    }
    return undefined;
};

export interface Playable {
    readonly path: string;
    readonly type: string;
}

/**
 * A rendition of `target` every browser plays, made now if this version of the file has none yet: its path and type, or
 * "rendering" when it is still being made after `waitMs` (the render goes on, and asking again later finds it).
 * Undefined when it is no recording or video, ffmpeg isn't here, or ffmpeg can't read it.
 */
export const playableMedia = async (root: string, target: string, waitMs: number = READY_WAIT_MS): Promise<Playable | "rendering" | undefined> => {
    const rendering = renderingFor(target);
    if (rendering === undefined || !(await videoToolsPresent())) {
        return undefined;
    }
    // allow(silent-catch): a file gone since the route sized it is no recording to render, which undefined says
    const version = await stat(target).catch(() => undefined);
    if (version === undefined) {
        return undefined;
    }
    // Which file and which version of it: an edit moves size or mtime, so a rendition never outlives what it was made from.
    const key = createHash("sha256").update(`${target}\n${version.size}\n${Math.trunc(version.mtimeMs)}\n${rendering.encoding}`).digest("hex");
    const file = join(cacheDir(root), `${key}.${rendering.extension}`);
    // allow(silent-catch): no rendition made yet is what a miss here means
    if ((await stat(file).catch(() => undefined)) !== undefined) {
        return { path: file, type: rendering.type };
    }
    // allow(silent-catch): a render that could not be written is no rendition, which undefined says
    const made = inFlight.run(file, () => render(target, file, rendering)).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"rendering">((resolve) => {
        timer = setTimeout(() => resolve("rendering"), waitMs);
    });
    try {
        const answer = await Promise.race([made, waited]);
        return answer === "rendering" ? answer : answer === undefined ? undefined : { path: answer, type: rendering.type };
    } finally {
        clearTimeout(timer);
    }
};

export interface MediaSource {
    readonly path: string;
    readonly type: string;
    readonly size: number;
}

/**
 * What GET /workspace/media streams for `target`: the file itself, or with `playable` its rendition, or why neither: the
 * file is gone (404), a rendition was asked for and none can be made here (415), or it is still being made (503, with
 * the Retry-After the player asks again after).
 */
export const mediaSourceFor = async (
    root: string,
    target: string,
    playable: boolean,
    sizeOf: (file: string) => Promise<number | undefined>,
): Promise<MediaSource | { readonly error: string; readonly status: 404 | 415 | 503; readonly headers?: Readonly<Record<string, string>> }> => {
    const size = await sizeOf(target);
    if (size === undefined) {
        return { error: "not found", status: 404 };
    }
    if (!playable) {
        return { path: target, type: contentTypeForPath(target), size };
    }
    const rendition = await playableMedia(root, target);
    if (rendition === "rendering") {
        return { error: "a playable rendition of this file is still being made", status: 503, headers: { "Retry-After": "2", "Cache-Control": "no-store" } };
    }
    if (rendition === undefined) {
        return { error: "no playable rendition of this file can be made here", status: 415 };
    }
    return { ...rendition, size: (await stat(rendition.path)).size };
};
