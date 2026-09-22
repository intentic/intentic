import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { test, expect } from "bun:test";
import { stateRelPath } from "../layout/state-paths.js";
import { isRendition, thumbnailable, workspaceThumbnail } from "./workspace-thumbnail.js";

// The same table entry the module under test builds its cache dir from, so the two cannot drift.
const CACHE = stateRelPath(".intentic/local/cache/", "thumbnails");

// A picture far larger than a tile, so the point of the exercise — that what comes back is not the original — is real.
const writePicture = async (path: string, width: number, height: number): Promise<number> => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })
        .png()
        .toBuffer();
    await writeFile(path, bytes);
    return bytes.byteLength;
};

test("workspaceThumbnail answers a small webp, not the file it was made from", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "shot.png");
    const sourceBytes = await writePicture(file, 1600, 1200);

    const thumbnail = await workspaceThumbnail(root, file);
    expect(thumbnail?.bytes).toBeInstanceOf(Buffer);
    expect(thumbnail?.etag).toMatch(/^[\da-f]{64}$/);
    expect(thumbnail!.bytes.byteLength).toBeLessThan(sourceBytes / 10);

    const drawn = await sharp(thumbnail!.bytes).metadata();
    expect(drawn.format).toBe("webp");
    // Scaled inside a 256px box, keeping the source's 4:3.
    expect(drawn.width).toBe(256);
    expect(drawn.height).toBe(192);
});

test("workspaceThumbnail renders once per version and re-renders when the picture changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "shot.png");
    await writePicture(file, 800, 800);

    const first = await workspaceThumbnail(root, file);
    const again = await workspaceThumbnail(root, file);
    expect(again!.etag).toBe(first!.etag);
    // One cache entry for one version, so the second look was a read rather than a decode.
    expect(await readdir(join(root, CACHE))).toHaveLength(1);

    // A different picture at the same path: new size, so a new key rather than the old thumbnail.
    await writePicture(file, 640, 480);
    const rewritten = await workspaceThumbnail(root, file);
    expect(rewritten!.etag).not.toBe(first!.etag);
    expect(await readdir(join(root, CACHE))).toHaveLength(2);
});

test("workspaceThumbnail re-renders when the same bytes are rewritten, since mtime moved", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "shot.png");
    await writePicture(file, 400, 400);
    const first = await workspaceThumbnail(root, file);

    await utimes(file, new Date(), new Date(Date.now() + 60_000));
    expect((await workspaceThumbnail(root, file))!.etag).not.toBe(first!.etag);
});

test("workspaceThumbnail answers nothing rather than failing, for a file there is no picture in", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    await writeFile(join(root, "broken.png"), "this is not a png");
    await writeFile(join(root, "empty.png"), "");

    expect(await workspaceThumbnail(root, join(root, "broken.png"))).toBeUndefined();
    expect(await workspaceThumbnail(root, join(root, "empty.png"))).toBeUndefined();
    expect(await workspaceThumbnail(root, join(root, "absent.png"))).toBeUndefined();
});

test("thumbnailable names the formats it will decode, and leaves svg out", () => {
    expect(thumbnailable("/w/a.png")).toBe(true);
    expect(thumbnailable("/w/a.JPEG")).toBe(true);
    expect(thumbnailable("/w/a.webp")).toBe(true);
    // Rasterising markup that can fetch and script is a different question from decoding a bitmap.
    expect(thumbnailable("/w/a.svg")).toBe(false);
    expect(thumbnailable("/w/a.ts")).toBe(false);
});

// A page taller than it is wide, red over its first screenful and blue below: what a full-page capture looks like.
const writePage = async (path: string): Promise<void> => {
    const top = await sharp({ create: { width: 1440, height: 900, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer();
    const page = await sharp({ create: { width: 1440, height: 4000, channels: 3, background: { r: 30, g: 30, b: 220 } } })
        .composite([{ input: top, left: 0, top: 0 }])
        .png()
        .toBuffer();
    await writeFile(path, page);
};

// The colour at the middle of a drawn picture, to tell which part of the page the rendition kept.
const middleOf = async (bytes: Buffer): Promise<{ r: number; b: number }> => {
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    return { r: data[at]!, b: data[at + 2]! };
};

test("a strip tile is the top of the page at 16:10, not the whole page shrunk to a sliver", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "full-page.png");
    await writePage(file);

    const strip = await workspaceThumbnail(root, file, "strip");
    const drawn = await sharp(strip!.bytes).metadata();
    expect([strip!.type, drawn.width, drawn.height]).toEqual(["image/webp", 480, 300]);
    const middle = await middleOf(strip!.bytes);
    expect(middle.r > middle.b).toBe(true);

    // The home's tile keeps the whole page inside its box, which for this page is 92 pixels wide.
    const tile = await sharp((await workspaceThumbnail(root, file, "tile"))!.bytes).metadata();
    expect([tile.width, tile.height]).toEqual([92, 256]);
});

test("a view keeps the picture's own size, as AVIF for a reader that decodes it and WebP for one that does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "shot.png");
    const sourceBytes = await writePicture(file, 1600, 1200);

    const avif = await workspaceThumbnail(root, file, "view", true);
    const webp = await workspaceThumbnail(root, file, "view", false);
    const avifDrawn = await sharp(avif!.bytes).metadata();
    const webpDrawn = await sharp(webp!.bytes).metadata();
    // sharp names AVIF by its container, HEIF, with AV1 inside.
    expect([avif!.type, avifDrawn.format, avifDrawn.compression, avifDrawn.width, avifDrawn.height]).toEqual(["image/avif", "heif", "av1", 1600, 1200]);
    expect([webp!.type, webpDrawn.format, webpDrawn.width, webpDrawn.height]).toEqual(["image/webp", "webp", 1600, 1200]);
    expect(avif!.bytes.byteLength).toBeLessThan(sourceBytes);
    // One version, two answers: each format is its own tag, so a cache keyed on Accept never serves the other.
    expect(avif!.etag).not.toBe(webp!.etag);
    expect(await readdir(join(root, CACHE))).toHaveLength(2);
});

test("a view no wider than a viewer draws, and a tile stays WebP even for a reader that decodes AVIF", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "wide.png");
    await writePicture(file, 3000, 1000);

    const view = await sharp((await workspaceThumbnail(root, file, "view", true))!.bytes).metadata();
    expect([view.width, view.height]).toEqual([2560, 853]);
    expect((await workspaceThumbnail(root, file, "tile", true))!.type).toBe("image/webp");
    expect((await workspaceThumbnail(root, file, "strip", true))!.type).toBe("image/webp");
});

// More at once than there are render slots: each waits its turn and every one is answered.
test("a burst of renders larger than the slots all complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const files = await Promise.all(
        Array.from({ length: 7 }, async (_, index) => {
            const file = join(root, `shot-${index}.png`);
            await writePicture(file, 640 + index, 480);
            return file;
        }),
    );
    const drawn = await Promise.all(files.map((file) => workspaceThumbnail(root, file, "view", true)));
    expect(drawn.map((picture) => picture?.type)).toEqual(Array.from({ length: 7 }, () => "image/avif"));
});

test("isRendition names exactly the three sizes the route answers", () => {
    expect(["tile", "strip", "view", "original", "toString", ""].map(isRendition)).toEqual([true, true, true, false, false, false]);
});
