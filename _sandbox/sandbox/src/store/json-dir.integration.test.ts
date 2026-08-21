import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { jsonDir } from "./json-dir.js";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-json-dir-"));
    dirs.push(dir);
    // Nested, so the mkdir-on-write path is exercised the way every real store uses it (.intentic/ rarely
    // exists on a fresh workspace).
    return join(dir, `${STATE_DIR}`, "entries");
};
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const NoteSchema = z.object({ text: z.string(), at: z.number().optional() });
const notes = (dir: string) => jsonDir(dir, (raw) => NoteSchema.safeParse(raw).data);

test("the id is the filename and never the body: grafted on read, absent on disk", async () => {
    const dir = await tempDir();
    const store = notes(dir);
    await store.write("first", { text: "hello" });

    expect(await store.read("first")).toEqual({ text: "hello", id: "first" });
    expect(JSON.parse(await readFile(join(dir, "first.json"), "utf8"))).toEqual({ text: "hello" });
    // Writing the same id again replaces it whole: the upsert every caller's approve/edit path relies on.
    await store.write("first", { text: "edited" });
    expect((await store.list()).entries).toEqual([{ text: "edited", id: "first" }]);
});

test("an absent directory lists empty rather than throwing, nothing has been written yet", async () => {
    expect(await notes(await tempDir()).list()).toEqual({ entries: [], invalid: [] });
});

test("a bad name, unparseable bytes, and a schema-rejected body are all reported invalid, never dropped", async () => {
    const dir = await tempDir();
    const store = notes(dir);
    await store.write("good", { text: "kept" });
    await writeFile(join(dir, "torn.json"), "{ not json");
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ nope: 1 }));
    await writeFile(join(dir, "bad.name!.json"), JSON.stringify({ text: "untrusted" }));
    // Not a .json file at all: ignored outright, not reported, only entries are the directory's business.
    await writeFile(join(dir, "README.md"), "notes");

    const { entries, invalid } = await store.list();
    expect(entries).toEqual([{ text: "kept", id: "good" }]);
    expect(invalid.toSorted()).toEqual(["bad.name!.json", "torn.json", "wrong-shape.json"]);
    // The same refusal on the single-entry path, so a route cannot read an entry `list` would not vouch for.
    expect(await store.read("bad.name!")).toBeUndefined();
});

test("a write leaves no temp behind, so a concurrent list never sees a half-written entry", async () => {
    const dir = await tempDir();
    const store = notes(dir);
    await store.write("only", { text: "swapped" });
    // The rename target is the only entry: a leftover temp would be a write that never completed its swap:
    // and one caught mid-swap must not surface as `invalid`, which is why the scan takes `.json` alone.
    expect(await readdir(dir)).toEqual(["only.json"]);
});

test("remove unlinks the entry; a second remove reports missing", async () => {
    const store = notes(await tempDir());
    await store.write("doomed", { text: "bye" });
    expect(await store.remove("doomed")).toBe(true);
    expect(await store.remove("doomed")).toBe(false);
    expect(await store.read("doomed")).toBeUndefined();
});
