import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import { expect, test } from "vitest";
import { extractTarToWorkspace, PathEscapeError } from "./workspace-archive.js";
import { UploadTooLargeError } from "./workspace-files.js";

// Build a tar and hand it back as a web ReadableStream (what the route feeds the extractor). Buffering the whole
// archive is fine in a test — the extractor still streams it back in.
const tarOf = async (
    entries: { name: string; content?: string; type?: "file" | "directory"; mtime?: Date }[],
): Promise<ReadableStream<Uint8Array>> => {
    const p = pack();
    for (const e of entries) {
        const opts = e.type === "directory" ? { name: e.name, type: "directory" as const } : { name: e.name };
        p.entry(e.mtime !== undefined ? { ...opts, mtime: e.mtime } : opts, e.content ?? "");
    }
    p.finalize();
    const chunks: Uint8Array[] = [];
    for await (const chunk of p) {
        chunks.push(chunk as Uint8Array);
    }
    return new Blob(chunks).stream();
};

test("extractTarToWorkspace materializes a nested tree under the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    await extractTarToWorkspace(
        root,
        await tarOf([
            { name: "a/b/c.txt", content: "hi" },
            { name: "root.txt", content: "x" },
            { name: "empty", type: "directory" },
        ]),
    );
    expect(await readFile(join(root, "a/b/c.txt"), "utf8")).toBe("hi");
    expect(await readFile(join(root, "root.txt"), "utf8")).toBe("x");
    await expect(access(join(root, "empty"))).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace writes every contained entry — former secrets, .git, and siblings alike", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    await extractTarToWorkspace(
        root,
        await tarOf([
            { name: ".env", content: "SECRET" },
            { name: "app/.git/config", content: "x" },
            { name: "keep.txt", content: "ok" },
        ]),
    );
    // No write floor: a former-secret file lands like any other; `.git` lands so a dropped repo keeps its remote.
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET");
    expect(await readFile(join(root, "app/.git/config"), "utf8")).toBe("x");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("ok");
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace preserves each entry's mtime (drives the re-upload size+mtime skip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    const mtime = new Date(1_700_000_000 * 1000);
    await extractTarToWorkspace(root, await tarOf([{ name: "a.txt", content: "hi", mtime }]));
    expect(Math.floor((await stat(join(root, "a.txt"))).mtimeMs / 1000)).toBe(1_700_000_000);
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace rejects an escaping entry path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    await expect(extractTarToWorkspace(root, await tarOf([{ name: "../evil.txt", content: "no" }]))).rejects.toBeInstanceOf(PathEscapeError);
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace skips a file entry that collides with an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    // A symlink alias can duplicate a directory as a file entry (Chrome follows symlinks; the packer can't flag it).
    // The directory subtree wins, the colliding file entry is skipped, and the rest of the upload still lands.
    await extractTarToWorkspace(
        root,
        await tarOf([
            { name: "d/x.txt", content: "1" },
            { name: "d", content: "collision" },
            { name: "keep.txt", content: "ok" },
        ]),
    );
    expect(await readFile(join(root, "d/x.txt"), "utf8")).toBe("1");
    expect((await stat(join(root, "d"))).isDirectory()).toBe(true);
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("ok");
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace skips a file entry whose parent path is already a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    // Mirror image (entry order is non-deterministic): `d` lands as a file first, then `d/x.txt` needs `d` to be a
    // directory. mkdir throws ENOTDIR; the entry is skipped rather than aborting the whole upload.
    await extractTarToWorkspace(
        root,
        await tarOf([
            { name: "d", content: "file" },
            { name: "d/x.txt", content: "1" },
            { name: "keep.txt", content: "ok" },
        ]),
    );
    expect((await stat(join(root, "d"))).isFile()).toBe(true);
    expect(await readFile(join(root, "d"), "utf8")).toBe("file");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("ok");
    await rm(root, { recursive: true, force: true });
});

test("extractTarToWorkspace enforces one byte budget across the whole archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "tar-"));
    const big = "x".repeat(1024);
    await expect(
        extractTarToWorkspace(
            root,
            await tarOf([
                { name: "a.txt", content: big },
                { name: "b.txt", content: big },
            ]),
            1500,
        ),
    ).rejects.toBeInstanceOf(UploadTooLargeError);
    await rm(root, { recursive: true, force: true });
});
