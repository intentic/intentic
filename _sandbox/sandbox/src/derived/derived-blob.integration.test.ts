import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { DERIVED_BLOBS_DIR, deriveBytes } from "./derived-blob.js";
import type { ExecFn } from "./fileq.js";

/* A past version's bytes as text: rendered once through fileq's out-of-workspace read, then found by hash. */

let root: string;
let out: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "derived-blob-root-"));
    out = await mkdtemp(join(tmpdir(), "derived-blob-out-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
});

// Stands in for `fileq read --json`: saves the rendering where fileq would and answers with where, as fileq does.
const reader = (markdown: string, calls: string[][]): ExecFn => {
    return async (command, args) => {
        calls.push([command, ...args]);
        const copy = args.at(-1) ?? "";
        const saved = join(out, `${calls.length}.md`);
        await writeFile(saved, `${markdown}\n`);
        return {
            stdout: `${JSON.stringify({ file: copy, format: "docx", deriver: "docx v1", tokens: 3, path: saved, source: "derived", notes: ["docx conversion: one style dropped"] })}\n`,
        };
    };
};

test("renders bytes through a temporary copy named like the file, and answers with fileq's text and notes", async () => {
    const calls: string[][] = [];
    const side = await deriveBytes(root, Buffer.from("PK..."), { name: "brief.docx" }, reader("# Brief\n\nHello.", calls));
    expect(side).toEqual({
        present: true,
        content: "# Brief\n\nHello.\n",
        deriver: "docx v1",
        notes: ["docx conversion: one style dropped"],
        truncated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 5)).toEqual(["fileq", "read", "--json", "--budget", "0"]);
    expect(calls[0]?.at(-1)?.endsWith("/brief.docx")).toBe(true);
    // The copy and fileq's saved file are both gone; only the kept rendering remains, under the content hash.
    expect(await readdir(out)).toEqual([]);
    const kept = await readdir(join(root, DERIVED_BLOBS_DIR));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^[0-9a-f]{64}\.md$/);
});

test("the same bytes are never rendered twice, whatever name they arrive under", async () => {
    const calls: string[][] = [];
    const exec = reader("same", calls);
    await deriveBytes(root, Buffer.from("bytes"), { name: "a.docx" }, exec);
    const again = await deriveBytes(root, Buffer.from("bytes"), { name: "renamed.docx" }, exec);
    expect(again).toMatchObject({ present: true, content: "same\n" });
    expect(calls).toHaveLength(1);
});

test("the file's own fresh shadow stands in for the side on disk, so the after side costs no render", async () => {
    const calls: string[][] = [];
    const bytes = Buffer.from("current version");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const shadow = join(root, STATE_DIR, "local/cache/derived", "docs/brief.docx.md");
    await mkdir(join(shadow, ".."), { recursive: true });
    await writeFile(shadow, `---\nsource: docs/brief.docx\nsha256: ${sha}\nderiver: docx v1\nnote: "kept"\n---\n\nFrom the shadow.\n`);
    const side = await deriveBytes(root, bytes, { name: "brief.docx", relPath: "docs/brief.docx" }, reader("never", calls));
    expect(side).toEqual({ present: true, content: "From the shadow.\n", deriver: "docx v1", notes: ["kept"], truncated: false });
    expect(calls).toHaveLength(0);
});

test("a stale shadow (other bytes) is passed over rather than shown as this version", async () => {
    const calls: string[][] = [];
    const shadow = join(root, STATE_DIR, "local/cache/derived", "brief.docx.md");
    await mkdir(join(shadow, ".."), { recursive: true });
    await writeFile(shadow, `---\nsource: brief.docx\nsha256: 0000\nderiver: docx v1\n---\n\nOld text.\n`);
    const side = await deriveBytes(root, Buffer.from("new bytes"), { name: "brief.docx", relPath: "brief.docx" }, reader("New text.", calls));
    expect(side).toMatchObject({ present: true, content: "New text.\n" });
    expect(calls).toHaveLength(1);
});

test("fileq's refusal comes back as the reason, and nothing is kept for it", async () => {
    const exec: ExecFn = async (_command, args) => {
        throw Object.assign(new Error("fileq failed"), { code: 1, stdout: `fileq: cannot read ${args.at(-1)}: derive-failed (docx): not a zip\n` });
    };
    const side = await deriveBytes(root, Buffer.from("garbage"), { name: "broken.docx" }, exec);
    expect(side).toEqual({ present: false, reason: "derive-failed (docx): not a zip" });
    await expect(readdir(join(root, DERIVED_BLOBS_DIR))).rejects.toThrow();
});

test("a sandbox without the binary blames the sandbox, not the file", async () => {
    const exec: ExecFn = async () => {
        throw Object.assign(new Error("spawn fileq ENOENT"), { code: "ENOENT" });
    };
    const side = await deriveBytes(root, Buffer.from("x"), { name: "x.pdf" }, exec);
    expect(side).toEqual({ present: false, reason: "this sandbox has no fileq binary, so nothing can be rendered as text here" });
});

test("two asks for one version in flight share a single render", async () => {
    const calls: string[][] = [];
    const exec = reader("shared", calls);
    const [a, b] = await Promise.all([
        deriveBytes(root, Buffer.from("twin"), { name: "t.docx" }, exec),
        deriveBytes(root, Buffer.from("twin"), { name: "t.docx" }, exec),
    ]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
    expect((await readFile(join(root, DERIVED_BLOBS_DIR, (await readdir(join(root, DERIVED_BLOBS_DIR)))[0] ?? ""), "utf8")).startsWith("---\n")).toBe(
        true,
    );
});
