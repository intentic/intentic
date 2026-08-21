import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MAX_TEXT_BYTES, readWorkspaceFileWindow, resolveWithin, UploadTooLargeError, writeWorkspaceFileStream } from "./workspace-files.js";

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([new Uint8Array(bytes)]).stream();

// A temp file holding `content`, and the dir to clean up after.
const fileWith = async (name: string, content: string | Uint8Array): Promise<{ dir: string; path: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "wfw-"));
    const path = join(dir, name);
    await writeFile(path, content);
    return { dir, path };
};

test("resolveWithin returns the absolute path for a contained file", () => {
    expect(resolveWithin("/work/intent", "deploy.config.ts")).toBe("/work/intent/deploy.config.ts");
    expect(resolveWithin("/work/intent", "nested/file.ts")).toBe("/work/intent/nested/file.ts");
});

test("resolveWithin rejects the repo dir itself", () => {
    expect(resolveWithin("/work/intent", ".")).toBeUndefined();
    expect(resolveWithin("/work/intent", "")).toBeUndefined();
});

test("resolveWithin rejects paths that climb out of the repo", () => {
    expect(resolveWithin("/work/intent", "../desired-state/secret")).toBeUndefined();
    expect(resolveWithin("/work/intent", "../../etc/passwd")).toBeUndefined();
    expect(resolveWithin("/work/intent", "/etc/passwd")).toBeUndefined();
});

test("resolveWithin normalizes a contained path that uses ..", () => {
    expect(resolveWithin("/work/intent", "nested/../deploy.config.ts")).toBe("/work/intent/deploy.config.ts");
});

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

// --- readWorkspaceFileWindow ---------------------------------------------------------------------

test("readWorkspaceFileWindow serves a small file whole, and says so", async () => {
    const { dir, path } = await fileWith("small.ts", "console.log(1);\n");
    expect(await readWorkspaceFileWindow(path)).toEqual({ content: "console.log(1);\n", size: 16, offset: 0, bytes: 16 });
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow bounds the read to `limit` and reports the file's TOTAL size", async () => {
    // 100 lines of 10 bytes. A 25-byte window can only hold two whole ones.
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
    const { dir, path } = await fileWith("big.log", `${lines}\n`);
    const head = await readWorkspaceFileWindow(path, 0, 25);
    expect(head?.size).toBe(900);
    expect(head?.offset).toBe(0);
    // Cut on a line boundary, not at byte 25: a viewer that opens mid-line reads as corrupt.
    expect(head?.content).toBe("line-000\nline-001\n");
    expect(head?.bytes).toBe(18);
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow reads the TAIL for a negative offset: how following a growing log starts", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
    const { dir, path } = await fileWith("big.log", `${lines}\n`);
    const tail = await readWorkspaceFileWindow(path, -30);
    expect(tail?.content).toBe("line-097\nline-098\nline-099\n");
    // The end of the file IS a boundary, so the last line is whole and nothing is trimmed off the end.
    expect((tail?.offset ?? 0) + (tail?.bytes ?? 0)).toBe(900);
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow's next window continues exactly where the last one ended", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n");
    const { dir, path } = await fileWith("big.log", `${lines}\n`);
    const first = await readWorkspaceFileWindow(path, 0, 25);
    const second = await readWorkspaceFileWindow(path, (first?.offset ?? 0) + (first?.bytes ?? 0), 25);
    // No seam and no duplication: paging is append-only for the reader.
    expect(`${first?.content}${second?.content}`).toBe("line-000\nline-001\nline-002\nline-003\n");
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow never splits a multi-byte character", async () => {
    // Four bytes each, so a byte-aligned cut lands mid-character.
    const { dir, path } = await fileWith("emoji.txt", "🙂".repeat(20));
    const window = await readWorkspaceFileWindow(path, 0, 10);
    expect(window?.size).toBe(80);
    // No U+FFFD replacement anywhere: the window backed off to a character boundary (no newline to snap to).
    expect(window?.content).not.toContain("�");
    expect(window?.content).toBe("🙂🙂");
    expect(window?.bytes).toBe(8);
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow keeps a single long line rather than serving nothing", async () => {
    // Minified JS, a one-line JSON log: there is no line boundary to snap to inside the window.
    const { dir, path } = await fileWith("min.js", "x".repeat(500));
    const window = await readWorkspaceFileWindow(path, 0, 100);
    expect(window?.content).toBe("x".repeat(100));
    expect(window?.bytes).toBe(100);
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow clamps `limit` to the daemon's cap, the ceiling is not the caller's to raise", async () => {
    const { dir, path } = await fileWith("small.ts", "ok\n");
    const window = await readWorkspaceFileWindow(path, 0, MAX_TEXT_BYTES * 4);
    expect(window?.content).toBe("ok\n");
    await rm(dir, { recursive: true, force: true });
});

test("readWorkspaceFileWindow past the end serves nothing, and a missing file is undefined", async () => {
    const { dir, path } = await fileWith("small.ts", "ok\n");
    expect(await readWorkspaceFileWindow(path, 999)).toEqual({ content: "", size: 3, offset: 3, bytes: 0 });
    expect(await readWorkspaceFileWindow(join(dir, "nope.ts"))).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
});
