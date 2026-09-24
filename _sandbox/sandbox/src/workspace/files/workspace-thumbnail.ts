import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp, { type ResizeOptions } from "sharp";
import { statePath } from "../../state-paths.js";

// A picture re-encoded for the way it is drawn, rather than moved as the file it is. Reading originals moved a gigabyte
// for a folder of screenshots and took seconds per picture on a slow link. Rendered once per version and kept on disk,
// so the second look costs a read.

// How a picture is drawn: `tile` whole inside a folder tile, `strip` as the top of the page in a chat strip's 16:10
// box, `view` at its own size in the viewer and a tool card.
export type Rendition = "tile" | "strip" | "view";

export type PictureType = "image/webp" | "image/avif";

interface Spec {
    readonly resize: ResizeOptions;
    readonly webpQuality: number;
    // Whether the rendition is big enough for AVIF's smaller bytes to repay its slower encode.
    readonly avif: boolean;
}

const SPECS: Record<Rendition, Spec> = {
    // Twice the tile's own box, so a HiDPI screen still draws a sharp one.
    tile: { resize: { width: 256, height: 256, fit: "inside", withoutEnlargement: true }, webpQuality: 72, avif: false },
    // Twice the strip tile on the widest reading column, cut from the top: a full-page capture shrunk whole is a sliver.
    strip: { resize: { width: 480, height: 300, fit: "cover", position: "top" }, webpQuality: 75, avif: false },
    // Its own size, capped where WebP stops encoding (16383 px) and wider than any viewer draws a screenshot.
    view: { resize: { width: 2560, height: 16383, fit: "inside", withoutEnlargement: true }, webpQuality: 80, avif: true },
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

const cacheDir = (root: string): string => statePath(root, ".intentic/local/cache/", "thumbnails");

const EXTENSIONS: Record<PictureType, string> = { "image/webp": "webp", "image/avif": "avif" };

// Which file, which version of it, and how it is drawn: an edit moves size or mtime, so a rendition can never outlive the
// picture it was made from and nothing has to be invalidated by hand. Doubles as the ETag.
const keyOf = (target: string, size: number, mtimeMs: number, rendition: Rendition, type: PictureType): string =>
    createHash("sha256").update(`${target}\n${size}\n${Math.trunc(mtimeMs)}\n${rendition}\n${type}`).digest("hex");

// Renders in flight, keyed by cache file, so a screenful of tiles landing on one picture decodes it once.
const rendering = new Map<string, Promise<Buffer | undefined>>();

// Renders running at once. Each holds one of libuv's four threads for its whole decode and encode, and those threads
// serve every file read the daemon makes, so an unbounded burst of pictures stalls unrelated requests behind it.
const RENDER_SLOTS = 2;
let busy = 0;
const queued: (() => void)[] = [];

// A released slot passes straight to the longest waiter, so `busy` never drops while anyone is queued for it.
const inSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy < RENDER_SLOTS) {
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

const encode = (target: string, rendition: Rendition, type: PictureType): Promise<Buffer | undefined> => {
    const spec = SPECS[rendition];
    const pipeline = sharp(target, { failOn: "none", animated: false })
        // Honours the EXIF orientation a phone photo carries, which the tile would otherwise draw on its side.
        .rotate()
        .resize(spec.resize);
    // AVIF at effort 0 rang around text on dark interfaces; effort 1 is the cheapest setting that stayed clean.
    const encoded = type === "image/avif" ? pipeline.avif({ quality: 55, effort: 1 }) : pipeline.webp({ quality: spec.webpQuality, effort: 2 });
    return inSlot(() => encoded.toBuffer()).catch(() => undefined);
};

const render = async (target: string, file: string, rendition: Rendition, type: PictureType): Promise<Buffer | undefined> => {
    const bytes = await encode(target, rendition, type);
    if (bytes === undefined) {
        return undefined;
    }
    const dir = join(file, "..");
    await mkdir(dir, { recursive: true });
    // Written beside and renamed in: two tabs asking at once must never read a half-written file.
    const partial = `${file}.${process.pid}.part`;
    await writeFile(partial, bytes);
    await rename(partial, file).catch(() => undefined);
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
    const pending = rendering.get(file) ?? render(target, file, rendition, type).finally(() => rendering.delete(file));
    rendering.set(file, pending);
    const bytes = await pending;
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
    if (info === undefined || !info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) {
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
