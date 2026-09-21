import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import { statePath } from "../layout/state-paths.js";

// A picture small enough to draw a tile with. The guest draws a folder as thumbnails an inch across; reading the original
// to do it moved the whole file per tile — a gigabyte for a folder of screenshots — and made the browser decode every
// one of them at full resolution to paint a box of 56 pixels. Rendered once per version and kept on disk, so the second
// look at a folder costs a read.

// The longest edge a thumbnail may have. Twice the tile's own box, so a HiDPI screen still draws a sharp one.
const MAX_EDGE = 256;
// Past this a source is not worth decoding to draw a tile; the guest keeps the file's glyph instead.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
// Thumbnails kept before the cache is emptied; at a few KB each this is a ceiling of roughly a hundred megabytes.
const MAX_CACHED = 20_000;

export const THUMBNAIL_TYPE = "image/webp";

// What sharp is asked to decode. SVG is deliberately absent: rasterising markup that can fetch and script is a
// different question from decoding a bitmap, and the guest has a glyph to fall back on.
const SOURCES: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".tiff", ".tif", ".bmp"]);

export const thumbnailable = (path: string): boolean => SOURCES.has(extname(path).toLowerCase());

const cacheDir = (root: string): string => statePath(root, ".intentic/local/cache/", "thumbnails");

// Which file, and which version of it: an edit moves size or mtime, so a thumbnail can never outlive the picture it was
// made from and nothing has to be invalidated by hand. Doubles as the ETag.
const keyOf = (target: string, size: number, mtimeMs: number): string =>
    createHash("sha256").update(`${target}\n${size}\n${Math.trunc(mtimeMs)}\n${MAX_EDGE}`).digest("hex");

// Renders in flight, keyed by cache file, so a screenful of tiles landing on one picture decodes it once.
const rendering = new Map<string, Promise<Buffer | undefined>>();

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

const render = async (target: string, file: string): Promise<Buffer | undefined> => {
    const bytes = await sharp(target, { failOn: "none", animated: false })
        // Honours the EXIF orientation a phone photo carries, which the tile would otherwise draw on its side.
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72, effort: 2 })
        .toBuffer()
        .catch(() => undefined);
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
    // The version this was rendered from, so a reload answers 304 instead of moving the bytes again.
    readonly etag: string;
}

/**
 * A downscaled WebP of the picture at `target`, rendered once per version and cached under the sandbox's own state.
 *
 * Answers undefined when there is nothing to draw: the file is gone, empty, too big to be worth decoding, or not
 * something sharp can read. The caller falls back to the file's glyph rather than reporting a failure.
 */
export const workspaceThumbnail = async (root: string, target: string): Promise<WorkspaceThumbnail | undefined> => {
    const info = await stat(target).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) {
        return undefined;
    }
    const etag = keyOf(target, info.size, info.mtimeMs);
    const file = join(cacheDir(root), `${etag}.webp`);
    const cached = await readFile(file).catch(() => undefined);
    if (cached !== undefined) {
        return { bytes: cached, etag };
    }
    const pending = rendering.get(file) ?? render(target, file).finally(() => rendering.delete(file));
    rendering.set(file, pending);
    const bytes = await pending;
    return bytes === undefined ? undefined : { bytes, etag };
};
