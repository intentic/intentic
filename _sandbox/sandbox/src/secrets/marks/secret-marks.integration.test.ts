import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecretMarks, marksOf, secretMarksDocument } from "./secret-marks.js";

// The keyed marks (secret-marks.ts): the key is minted once, on first use, kept 0600 in the auth root, and read back by
// every later marker, so a value marks the same across restarts and differently under another name or once it changes.

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-secret-marks-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("the key is minted on first use and kept, so a value marks the same across restarts and never as itself", async () => {
    const path = join(root, secretMarksDocument.path);
    const mark = await fileSecretMarks(path).marker();
    const again = await fileSecretMarks(path).marker();
    expect(again("DB_PASSWORD", "hunter2-value")).toBe(mark("DB_PASSWORD", "hunter2-value"));
    expect(mark("DB_PASSWORD", "hunter2-value")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(mark("DB_PASSWORD", "hunter2-value!")).not.toBe(mark("DB_PASSWORD", "hunter2-value"));
    // One value under two names marks differently.
    expect(mark("OTHER", "hunter2-value")).not.toBe(mark("DB_PASSWORD", "hunter2-value"));
    expect(await readFile(path, "utf8")).not.toContain("hunter2-value");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("marks are answered for the names a store holds, once each", async () => {
    const marks = fileSecretMarks(join(root, secretMarksDocument.path));
    const held = new Map([["A", "value-of-a"]]);
    const answered = await marksOf(["A", "B", "A"], { marks, value: async (name) => held.get(name) });
    expect(answered).toEqual({ A: (await marks.marker())("A", "value-of-a") });
});
