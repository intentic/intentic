import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLines, textFile } from "./text-file.js";

const roots: string[] = [];
const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "text-file-"));
    roots.push(root);
    return root;
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a change that answers undefined leaves a missing file missing and an existing one untouched", async () => {
    const root = await scratch();
    const absent = join(root, "absent");
    expect(await textFile(absent).update(() => undefined)).toBe("");
    await expect(stat(absent)).rejects.toThrow();

    const present = join(root, "present");
    await writeFile(present, "kept\n");
    const before = (await stat(present)).ino;
    expect(await textFile(present).update(() => undefined)).toBe("kept\n");
    expect((await stat(present)).ino).toBe(before);
});

test("ensureLines creates a missing file, and its directory, holding the note and the lines", async () => {
    const root = await scratch();
    const path = join(root, "info", "exclude");
    await ensureLines(path, ["/a/", "/b/"], { note: "# ours" });
    expect(await readFile(path, "utf8")).toBe("# ours\n/a/\n/b/\n");
});

test("ensureLines keeps what the file holds byte for byte and appends only what it lacks", async () => {
    const root = await scratch();
    const path = join(root, "exclude");
    // No trailing newline, a CRLF line and blank lines: none of it is the helper's to tidy.
    await writeFile(path, "# owner\r\n/a/\r\n\n\n*.log");
    await ensureLines(path, ["/a/", "*.log", "/b/"], { note: "# ours" });
    expect(await readFile(path, "utf8")).toBe("# owner\r\n/a/\r\n\n\n*.log\n# ours\n/b/\n");
});

test("ensureLines is idempotent: a second call writes nothing, and the note is never repeated", async () => {
    const root = await scratch();
    const path = join(root, "exclude");
    await ensureLines(path, ["/a/"], { note: "# ours" });
    const first = await stat(path);
    await ensureLines(path, ["/a/"], { note: "# ours" });
    expect((await stat(path)).ino).toBe(first.ino);
    // A later line under the same note goes in without a second copy of the note.
    await ensureLines(path, ["/a/", "/b/"], { note: "# ours" });
    expect(await readFile(path, "utf8")).toBe("# ours\n/a/\n/b/\n");
});

test("concurrent ensureLines on one file keep every caller's lines", async () => {
    const root = await scratch();
    const path = join(root, "exclude");
    await Promise.all(["/a/", "/b/", "/c/", "/d/"].map((line) => ensureLines(path, [line])));
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines.toSorted()).toEqual(["/a/", "/b/", "/c/", "/d/"]);
});
