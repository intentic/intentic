import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationsRoot, conversationUnit, conversationUnits } from "./conversation-units.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HOUR_MS = 60 * 60_000;

const historyRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "conversation-units-"));
    roots.push(root);
    return root;
};

// A unit holding one file, its directory last touched `ageMs` before `now`.
const unitAged = async (root: string, id: string, now: number, ageMs: number): Promise<void> => {
    const dir = conversationUnit(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "transcript.jsonl"), "{}\n");
    const at = new Date(now - ageMs);
    await utimes(dir, at, at);
};

test("removing takes each named directory whole, nested stores included, and nothing beside it", async () => {
    const root = await historyRoot();
    const units = conversationUnits(root, () => false);
    await mkdir(join(units.dir("gone"), "sessions", "projects"), { recursive: true });
    await writeFile(join(units.dir("gone"), "sessions", "projects", "s.jsonl"), "{}\n");
    await unitAged(root, "kept", Date.now(), 0);

    await units.remove(["gone", "never-had-one"]);

    expect(await readdir(conversationsRoot(root))).toEqual(["kept"]);
});

test("the sweep takes an unowned directory past the grace, and leaves an owned one, a young one and anything not a unit", async () => {
    const root = await historyRoot();
    const now = Date.now();
    await unitAged(root, "owned", now, 2 * HOUR_MS);
    await unitAged(root, "orphan", now, 2 * HOUR_MS);
    // A fork's copy, made before the turn that registers it has begun.
    await unitAged(root, "opening", now, 60_000);
    await writeFile(join(conversationsRoot(root), "notes.txt"), "not a unit");

    expect(await conversationUnits(root, (id) => id === "owned").sweep(now)).toEqual(["orphan"]);
    expect((await readdir(conversationsRoot(root))).toSorted()).toEqual(["notes.txt", "opening", "owned"]);
});

test("a volume with no units yet sweeps nothing rather than failing boot", async () => {
    expect(await conversationUnits(await historyRoot(), () => false).sweep(Date.now())).toEqual([]);
});

test("files lists the first ones by path under the unit with their sizes, and how many there are in all", async () => {
    const root = await historyRoot();
    const units = conversationUnits(root, () => true);
    await mkdir(join(units.dir("c1"), "sessions"), { recursive: true });
    await Promise.all([
        writeFile(join(units.dir("c1"), "transcript.jsonl"), "12345"),
        writeFile(join(units.dir("c1"), "system-prompt.json"), "{}"),
        writeFile(join(units.dir("c1"), "sessions", "a.jsonl"), "abc"),
    ]);

    expect(await units.files("c1", 2)).toEqual({
        files: [
            { path: "sessions/a.jsonl", bytes: 3 },
            { path: "system-prompt.json", bytes: 2 },
        ],
        total: 3,
    });
    expect(await units.files("nothing-here", 2)).toEqual({ files: [], total: 0 });
});

test("a unit path is only ever built from a conversation id", () => {
    expect(() => conversationUnit("/history", "../gits")).toThrow('not a conversation id: "../gits"');
    expect(conversationUnit("/history", "c1")).toBe(join("/history", "conversations", "c1"));
});
