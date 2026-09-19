import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { thumbnailable, workspaceThumbnail } from "./workspace-thumbnail.js";

const CACHE = ".intentic/local/cache/thumbnails";

// A picture far larger than a tile, so the point of the exercise — that what comes back is not the original — is real.
const writePicture = async (path: string, width: number, height: number): Promise<number> => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
    await writeFile(path, bytes);
    return bytes.byteLength;
};

test("workspaceThumbnail answers a small webp, not the file it was made from", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-thumb-"));
    const file = join(root, "shot.png");
    const sourceBytes = await writePicture(file, 1600, 1200);

    const thumbnail = await workspaceThumbnail(root, file);
    expect(thumbnail).toMatchObject({ bytes: expect.any(Buffer), etag: expect.stringMatching(/^[\da-f]{64}$/) });
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
