import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { runCheck } from "../../../workload/run-check.js";
import { statePath } from "../../../state-paths.js";
import { contentTypeForPath } from "../workspace-files-download.js";
import { videoToolsPresent } from "./workspace-video.js";

// A recording the reader's browser can't decode (AIFF and CAF outside Safari, WMA, AMR, a WAV holding ADPCM or 64-bit
// floats), made playable: ffmpeg renders it once into AAC in an MP4 box, which every engine plays, and the rendition is
// kept per version of the file so a reopen streams it at once. The player asks for it only after the original failed to
// decode (MediaViewer), so a file the browser plays is never touched.

// What this renders: anything the media route types as audio, which is the set the editor files under audio too.
const isAudio = (path: string): boolean => contentTypeForPath(path).startsWith("audio/");

const PLAYABLE_TYPE = "audio/mp4";

// An hour of speech renders in well under a minute; past this the file isn't one a person is waiting to hear.
const RENDER_TIMEOUT_MS = 5 * 60_000;
// ffmpeg's own complaints are a line or two; a bound, not a budget.
const CAPTURE_BYTES = 64 * 1024;
// Renditions kept before the cache is emptied. One is about 1.4 MB a minute at the bitrate below, so this bounds it at a
// few gigabytes even for long recordings, and the price of forgetting is one render.
const MAX_CACHED = 64;
// Bumped when the encoding below changes, so renditions made at old settings are not served.
const ENCODING = "aac-192k-v1";

const cacheDir = (root: string): string => statePath(root, ".intentic/local/cache/", "playable");

// Renders in flight, keyed by their cache file: a player's first range requests all land on one ffmpeg.
const rendering = new SingleFlight<string, string | undefined>();

// Empties the cache once it holds more than it should, the thumbnails' rule (workspace-thumbnail.ts): a cache may forget.
const sweep = async (dir: string): Promise<void> => {
    const held = await readdir(dir).catch((): string[] => []);
    if (held.length > MAX_CACHED) {
        // allow(silent-catch): a cache that cannot be emptied just stays as it is until the next render tries again
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
};

const render = async (target: string, file: string): Promise<string | undefined> => {
    const dir = join(file, "..");
    await sweep(dir);
    await mkdir(dir, { recursive: true });
    // Written beside its final name and moved into place whole, so a second reader never streams a half-made file.
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
            // The first audio stream only: no cover art (an attached picture would make the box a video), no subtitles.
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            // The index up front, so the player can start and seek before it has read to the end.
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            partial,
        ],
        timeoutMs: RENDER_TIMEOUT_MS,
        workload: { class: "command" },
        kind: "media-probe",
        captureBytes: CAPTURE_BYTES,
    });
    if (ran.exitCode !== 0) {
        // allow(silent-catch): the scratch file may never have been written
        await rm(partial, { force: true }).catch(() => undefined);
        return undefined;
    }
    await rename(partial, file);
    return file;
};

/**
 * The path of a rendition of `target` every browser plays, made now if this version of the file has none yet.
 * Undefined when it is no recording, ffmpeg isn't here, or ffmpeg can't read it.
 */
export const playableAudio = async (root: string, target: string): Promise<string | undefined> => {
    if (!isAudio(target) || !(await videoToolsPresent())) {
        return undefined;
    }
    // allow(silent-catch): a file gone since the route sized it is no recording to render, which undefined says
    const version = await stat(target).catch(() => undefined);
    if (version === undefined) {
        return undefined;
    }
    // Which file and which version of it: an edit moves size or mtime, so a rendition never outlives what it was made from.
    const key = createHash("sha256").update(`${target}\n${version.size}\n${Math.trunc(version.mtimeMs)}\n${ENCODING}`).digest("hex");
    const file = join(cacheDir(root), `${key}.m4a`);
    // allow(silent-catch): no rendition made yet is what a miss here means
    if ((await stat(file).catch(() => undefined)) !== undefined) {
        return file;
    }
    // allow(silent-catch): a render that could not be written is no rendition, which undefined says
    return rendering.run(file, () => render(target, file)).catch(() => undefined);
};

export interface MediaSource {
    readonly path: string;
    readonly type: string;
    readonly size: number;
}

/**
 * What GET /workspace/media streams for `target`: the file itself, or with `playable` its rendition, or why neither: the
 * file is gone (404), or a rendition was asked for and none can be made here (415).
 */
export const mediaSourceFor = async (
    root: string,
    target: string,
    playable: boolean,
    sizeOf: (file: string) => Promise<number | undefined>,
): Promise<MediaSource | { readonly error: string; readonly status: 404 | 415 }> => {
    const size = await sizeOf(target);
    if (size === undefined) {
        return { error: "not found", status: 404 };
    }
    if (!playable) {
        return { path: target, type: contentTypeForPath(target), size };
    }
    const rendition = await playableAudio(root, target);
    if (rendition === undefined) {
        return { error: "no playable rendition of this file can be made here", status: 415 };
    }
    return { path: rendition, type: PLAYABLE_TYPE, size: (await stat(rendition)).size };
};
