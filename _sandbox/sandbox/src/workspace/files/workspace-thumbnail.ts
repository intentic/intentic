import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { SingleFlight } from "@intentic/base/async";
import { writeFileAtomic } from "@intentic/base/fs";
import sharp, { type ResizeOptions } from "sharp";
import type { PictureEdge } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { statePath } from "../../state-paths.js";
import { isVideo, videoPoster } from "./media/workspace-video.js";

// A picture re-encoded for the way it is drawn, rather than moved as the file it is. Reading originals moved a gigabyte
// for a folder of screenshots and took seconds per picture on a slow link. Rendered once per version and kept on disk,
// so the second look costs a read.

// How a picture is drawn: `tile` whole inside a folder tile, `strip` as the top of the page in a chat strip's 16:10 box,
// `view` at its own size in the viewer and a tool card, and `e<edge>` whole inside a square of that edge, for a reader
// drawing it at whatever size its box is (PICTURE_EDGES). `gallery` is what a gallery row asked for before the edges.
export type Rendition = "tile" | "gallery" | "strip" | "view" | `e${PictureEdge}`;

export type PictureType = "image/webp" | "image/avif";

interface Spec {
    readonly resize: ResizeOptions;
    readonly webpQuality: number;
    // Whether the rendition is big enough for AVIF's smaller bytes to repay its slower encode.
    readonly avif: boolean;
}

const edge = (side: PictureEdge): Spec => ({
    resize: { width: side, height: side, fit: "inside", withoutEnlargement: true },
    webpQuality: side <= 768 ? 78 : 80,
    avif: side >= 1024,
});

const SPECS: Record<Rendition, Spec> = {
    // Twice the tile's own box, so a HiDPI screen still draws a sharp one.
    tile: { resize: { width: 256, height: 256, fit: "inside", withoutEnlargement: true }, webpQuality: 72, avif: false },
    // Twice the tallest gallery row, so a HiDPI screen still draws it sharp; a row sets the height, so the width is only a
    // cap for a panorama.
    gallery: { resize: { width: 1440, height: 480, fit: "inside", withoutEnlargement: true }, webpQuality: 74, avif: false },
    // Twice the strip tile on the widest reading column, cut from the top: a full-page capture shrunk whole is a sliver.
    strip: { resize: { width: 480, height: 300, fit: "cover", position: "top" }, webpQuality: 75, avif: false },
    // Its own size, capped where WebP stops encoding (16383 px) and wider than any viewer draws a screenshot.
    view: { resize: { width: 2560, height: 16383, fit: "inside", withoutEnlargement: true }, webpQuality: 80, avif: true },
    // Never enlarged: a picture smaller than the edge comes back at its own size, which the reader can tell by its pixels.
    // AVIF from 1024 up, where its bytes are a third smaller and the encode is a one-off the cache keeps.
    e384: edge(384),
    e512: edge(512),
    e768: edge(768),
    e1024: edge(1024),
    e1536: edge(1536),
    e2048: edge(2048),
};

export const isRendition = (name: string): name is Rendition => Object.hasOwn(SPECS, name);

// Past this a source is not worth decoding; the guest keeps the file's glyph instead.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
// Renditions kept before the cache is emptied; a view is tens of KB, so this is a ceiling of about a gigabyte.
const MAX_CACHED = 20_000;

// What sharp is asked to decode. SVG is deliberately absent: rasterising markup that can fetch and script is a
// different question from decoding a bitmap, and the guest has a glyph to fall back on.
const SOURCES: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".tiff", ".tif", ".bmp"]);

export const thumbnailable = (path: string): boolean => SOURCES.has(extname(path).toLowerCase());

// A video is drawn from one frame of it (workspace-video.ts), only where ffmpeg is there to cut it; the route asks that.
export { isVideo, videoToolsPresent } from "./media/workspace-video.js";

const cacheDir = (root: string): string => statePath(root, ".intentic/local/cache/", "thumbnails");

const EXTENSIONS: Record<PictureType, string> = { "image/webp": "webp", "image/avif": "avif" };

// Which file, which version of it, and how it is drawn: an edit moves size or mtime, so a rendition can never outlive the
// picture it was made from and nothing has to be invalidated by hand. Doubles as the ETag.
const keyOf = (target: string, size: number, mtimeMs: number, rendition: Rendition, type: PictureType): string =>
    createHash("sha256").update(`${target}\n${size}\n${Math.trunc(mtimeMs)}\n${rendition}\n${type}`).digest("hex");

// Renders in flight, keyed by cache file, so a screenful of tiles landing on one picture decodes it once.
const rendering = new SingleFlight<string, Buffer | undefined>();

// At most `count` of a kind of work at once. A released slot passes straight to the longest waiter, so `busy` never
// drops while anyone is queued for it.
const slots = (count: number) => {
    let busy = 0;
    const queued: (() => void)[] = [];
    return async <T>(work: () => Promise<T>): Promise<T> => {
        if (busy < count) {
            busy += 1;
        } else {
            await new Promise<void>((resolve) => queued.push(resolve));
        }
        try {
            return await work();
        } finally {
            const next = queued.shift();
            if (next === undefined) {
                busy -= 1;
            } else {
                next();
            }
        }
    };
};

// Renders running at once. Each holds one of libuv's four threads for its whole decode and encode, and those threads
// serve every file read the daemon makes, so an unbounded burst of pictures stalls unrelated requests behind it.
const inSlot = slots(2);
// Videos having their frame cut at once: each is an ffmpeg process decoding a moment of 1080p, which a folder of
// recordings scrolled through would otherwise start by the dozen. Apart from the pictures', so they never wait on it.
const inVideoSlot = slots(2);

// Renders since the last count. The check is deliberately rare: counting the directory is the only cost this cache has
// that scales with what is in it.
let sinceSweep = 0;
const SWEEP_EVERY = 500;

// Empties the cache once it holds more than it should. Emptying rather than evicting the oldest: ranking them means a
// stat per entry, which is the very cost this file exists to avoid, and the price of being wrong is one re-render of
// whatever is on screen. A cache is allowed to forget.
const sweep = async (dir: string): Promise<void> => {
    sinceSweep += 1;
    if (sinceSweep < SWEEP_EVERY) {
        return;
    }
    sinceSweep = 0;
    const held = await readdir(dir).catch((): string[] => []);
    if (held.length > MAX_CACHED) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
};

// The version of a source a rendition is made from.
interface Version {
    readonly size: number;
    readonly mtimeMs: number;
}

// Frames being cut, keyed by their cache file, so the renditions a screenful asks of one video wait on one ffmpeg.
const cutting = new SingleFlight<string, Buffer | undefined>();

// A video's frame, cut once per version of the file and kept beside its renditions: every size a reader draws it at
// is re-encoded from the one frame, rather than each sending ffmpeg back into the film.
const posterOf = async (target: string, scratch: string, version: Version): Promise<Buffer | undefined> => {
    const key = createHash("sha256").update(`${target}\n${version.size}\n${Math.trunc(version.mtimeMs)}\nposter`).digest("hex");
    const file = join(scratch, `${key}.png`);
    // allow(silent-catch): a frame not cut yet is what a miss here means
    const kept = await readFile(file).catch(() => undefined);
    if (kept !== undefined) {
        return kept;
    }
    return cutting.run(file, async () => {
        // The frame is written through the cache's own directory, which a first render has yet to make.
        await mkdir(scratch, { recursive: true });
        const frame = await inVideoSlot(() => videoPoster(target, scratch));
        if (frame !== undefined) {
            // allow(silent-catch): a cache is allowed to forget, see sweep
            await writeFileAtomic(file, frame).catch(() => undefined);
        }
        return frame;
    });
};

// A picture is decoded from its file; a video from the frame its tile shows. A video ffmpeg cannot read has no frame,
// and the tile keeps its glyph.
const sourceOf = (target: string, scratch: string, version: Version): Promise<string | Buffer | undefined> =>
    isVideo(target) ? posterOf(target, scratch, version) : Promise.resolve(target);

const encode = async (target: string, scratch: string, rendition: Rendition, type: PictureType, version: Version): Promise<Buffer | undefined> => {
    const spec = SPECS[rendition];
    // allow(silent-catch): a cache directory that cannot be made is no picture to draw, the answer encode gives below too
    const source = await sourceOf(target, scratch, version).catch(() => undefined);
    if (source === undefined) {
        return undefined;
    }
    const pipeline = sharp(source, { failOn: "none", animated: false })
        // Honours the EXIF orientation a phone photo carries, which the tile would otherwise draw on its side.
        .rotate()
        .resize(spec.resize);
    // AVIF at effort 0 rang around text on dark interfaces; effort 1 is the cheapest setting that stayed clean.
    const encoded = type === "image/avif" ? pipeline.avif({ quality: 55, effort: 1 }) : pipeline.webp({ quality: spec.webpQuality, effort: 2 });
    return inSlot(() => encoded.toBuffer()).catch(() => undefined);
};

const render = async (target: string, file: string, rendition: Rendition, type: PictureType, version: Version): Promise<Buffer | undefined> => {
    const dir = join(file, "..");
    const bytes = await encode(target, dir, rendition, type, version);
    if (bytes === undefined) {
        return undefined;
    }
    // Replaced whole, so two tabs asking at once never read a half-written file. A write that fails costs the next look
    // a render, never this one its picture: the bytes are already in hand.
    // allow(silent-catch): a cache is allowed to forget, see sweep
    await writeFileAtomic(file, bytes).catch(() => undefined);
    await sweep(dir);
    return bytes;
};

export interface WorkspaceThumbnail {
    readonly bytes: Buffer;
    readonly type: PictureType;
    // The version this was rendered from, so a reload answers 304 instead of moving the bytes again.
    readonly etag: string;
}

const renditionOf = async (root: string, target: string, rendition: Rendition, type: PictureType, size: number, mtimeMs: number) => {
    const etag = keyOf(target, size, mtimeMs, rendition, type);
    const file = join(cacheDir(root), `${etag}.${EXTENSIONS[type]}`);
    const cached = await readFile(file).catch(() => undefined);
    if (cached !== undefined) {
        return { bytes: cached, type, etag };
    }
    const bytes = await rendering.run(file, () => render(target, file, rendition, type, { size, mtimeMs }));
    return bytes === undefined ? undefined : { bytes, type, etag };
};

/**
 * The picture at `target` drawn as `rendition`: AVIF where the rendition earns it and the reader decodes it, else WebP.
 *
 * Answers undefined when there is nothing to draw: the file is gone, empty, too big to be worth decoding, or not
 * something sharp can read. The caller falls back to the file's glyph rather than reporting a failure.
 */
export const workspaceThumbnail = async (root: string, target: string, rendition: Rendition = "tile", readsAvif = false): Promise<WorkspaceThumbnail | undefined> => {
    const info = await stat(target).catch(() => undefined);
    // A video is never decoded whole: ffmpeg seeks to the frame it cuts, so its size is no measure of the work.
    if (info === undefined || !info.isFile() || info.size === 0 || (info.size > MAX_SOURCE_BYTES && !isVideo(target))) {
        return undefined;
    }
    if (readsAvif && SPECS[rendition].avif) {
        // An encoder refusal is not a missing picture: the WebP of the same rendition still draws.
        const avif = await renditionOf(root, target, rendition, "image/avif", info.size, info.mtimeMs);
        if (avif !== undefined) {
            return avif;
        }
    }
    return renditionOf(root, target, rendition, "image/webp", info.size, info.mtimeMs);
};
