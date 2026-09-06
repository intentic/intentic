import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { UploadTooLargeError, writeWorkspaceFileStream } from "./workspace-files-upload.js";

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([new Uint8Array(bytes)]).stream();

test("writeWorkspaceFileStream streams a body to disk, creating parent dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    const target = join(dir, "nested/deep/file.bin");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await writeWorkspaceFileStream(target, streamOf(bytes), 1024);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    await rm(dir, { recursive: true, force: true });
});

test("writeWorkspaceFileStream refuses a body past the limit and removes the partial", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    const target = join(dir, "big.bin");
    await expect(writeWorkspaceFileStream(target, streamOf(new Uint8Array(2048)), 1024)).rejects.toBeInstanceOf(UploadTooLargeError);
    await expect(access(target)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
});

test("writeWorkspaceFileStream concatenates offset parts, and a re-sent part overwrites in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    const target = join(dir, "split.bin");
    await writeWorkspaceFileStream(target, streamOf(new Uint8Array([1, 2, 3])), 1024);
    await writeWorkspaceFileStream(target, streamOf(new Uint8Array([4, 5, 6])), 1024, 3);
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    // A retried part re-sends the same bytes at the same offset: idempotent.
    await writeWorkspaceFileStream(target, streamOf(new Uint8Array([9, 9, 9])), 1024, 3);
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([1, 2, 3, 9, 9, 9]));
    await rm(dir, { recursive: true, force: true });
});

test("writeWorkspaceFileStream counts the offset against the limit and keeps the file when a later part fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    const target = join(dir, "split.bin");
    await writeWorkspaceFileStream(target, streamOf(new Uint8Array(512)), 1024);
    await expect(writeWorkspaceFileStream(target, streamOf(new Uint8Array(600)), 1024, 512)).rejects.toBeInstanceOf(UploadTooLargeError);
    await expect(access(target)).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
});
