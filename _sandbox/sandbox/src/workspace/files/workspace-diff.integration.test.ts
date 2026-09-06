import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { computeUploadSkip } from "./workspace-diff.js";
import { setWorkspaceMtime } from "./workspace-files.js";

const MTIME = 1_700_000_000_000; // fixed ms (whole second, no sub-second component)

test("computeUploadSkip skips only files matching size AND whole-second mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "diff-"));
    for (const name of ["same.txt", "resized.txt", "touched.txt"]) {
        await writeFile(join(root, name), "hello"); // 5 bytes
        await setWorkspaceMtime(join(root, name), MTIME);
    }
    const skip = await computeUploadSkip(root, [
        { path: "same.txt", size: 5, mtime: MTIME }, // identical → skip
        { path: "resized.txt", size: 6, mtime: MTIME }, // size differs → upload
        { path: "touched.txt", size: 5, mtime: MTIME + 2000 }, // mtime differs by >1s → upload
        { path: "missing.txt", size: 5, mtime: MTIME }, // absent → upload
    ]);
    expect(skip).toEqual(["same.txt"]);
    await rm(root, { recursive: true, force: true });
});

test("computeUploadSkip compares mtime at second granularity (sub-second drift still skips)", async () => {
    const root = await mkdtemp(join(tmpdir(), "diff-"));
    await writeFile(join(root, "f.txt"), "abc");
    await setWorkspaceMtime(join(root, "f.txt"), MTIME);
    const skip = await computeUploadSkip(root, [{ path: "f.txt", size: 3, mtime: MTIME + 500 }]); // +0.5s
    expect(skip).toEqual(["f.txt"]);
    await rm(root, { recursive: true, force: true });
});

test("computeUploadSkip never skips an escaping path, but an identical former-secret file now skips", async () => {
    const root = await mkdtemp(join(tmpdir(), "diff-"));
    // A file already identical on disk is reported skippable so its bytes don't re-upload: former-secret paths
    // included now (no write floor). An escaping path is never skippable (resolveWithin rejects it).
    await writeFile(join(root, ".env"), "SECRET");
    await setWorkspaceMtime(join(root, ".env"), MTIME);
    const skip = await computeUploadSkip(root, [
        { path: "../escape.txt", size: 1, mtime: MTIME },
        { path: ".env", size: 6, mtime: MTIME },
    ]);
    expect(skip).toEqual([".env"]);
    await rm(root, { recursive: true, force: true });
});
