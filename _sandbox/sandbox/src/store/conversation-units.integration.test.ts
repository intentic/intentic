import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationsRoot, conversationUnit, conversationUnits, QUARANTINE_MS, quarantineRoot, type UnitOwners } from "./conversation-units.js";

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

// A database holding the rows named, made this boot or not.
const owning = (ids: readonly string[], recreated = false): UnitOwners => ({ has: (id) => ids.includes(id), any: () => ids.length > 0, recreated });

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
    const units = conversationUnits(root, owning([]));
    await mkdir(join(units.dir("gone"), "sessions", "projects"), { recursive: true });
    await writeFile(join(units.dir("gone"), "sessions", "projects", "s.jsonl"), "{}\n");
    await unitAged(root, "kept", Date.now(), 0);

    await units.remove(["gone", "never-had-one"]);

    expect(await readdir(conversationsRoot(root))).toEqual(["kept"]);
});

test("the sweep moves an unowned directory past the grace aside, and leaves an owned one, a young one and anything not a unit", async () => {
    const root = await historyRoot();
    const now = Date.now();
    await unitAged(root, "owned", now, 2 * HOUR_MS);
    await unitAged(root, "orphan", now, 2 * HOUR_MS);
    // A fork's copy, made before the turn that registers it has begun.
    await unitAged(root, "opening", now, 60_000);
    await writeFile(join(conversationsRoot(root), "notes.txt"), "not a unit");

    expect(await conversationUnits(root, owning(["owned"])).sweep(now)).toEqual({ quarantined: ["orphan"], pruned: [] });
    expect((await readdir(conversationsRoot(root))).toSorted()).toEqual(["notes.txt", "opening", "owned"]);
    // Moved whole, nothing deleted, and stamped with the moment it was set aside.
    expect(await readFile(join(quarantineRoot(root), "orphan", "transcript.jsonl"), "utf8")).toBe("{}\n");
    expect((await stat(join(quarantineRoot(root), "orphan"))).mtimeMs).toBe(now);
});

test("a directory set aside is removed for good only once it has been kept its while", async () => {
    const root = await historyRoot();
    const now = Date.now();
    const units = conversationUnits(root, owning(["owned"]));
    await unitAged(root, "owned", now, 2 * HOUR_MS);
    await unitAged(root, "orphan", now, 2 * HOUR_MS);
    await units.sweep(now);

    expect(await units.sweep(now + QUARANTINE_MS)).toEqual({ quarantined: [], pruned: [] });
    expect(await readdir(quarantineRoot(root))).toEqual(["orphan"]);
    expect(await units.sweep(now + QUARANTINE_MS + 1)).toEqual({ quarantined: [], pruned: ["orphan"] });
    expect(await readdir(quarantineRoot(root))).toEqual([]);
});

test("an orphan whose id was set aside before goes beside it, not over it", async () => {
    const root = await historyRoot();
    const now = Date.now();
    const units = conversationUnits(root, owning(["owned"]));
    await unitAged(root, "owned", now, 2 * HOUR_MS);
    await unitAged(root, "orphan", now, 2 * HOUR_MS);
    await units.sweep(now);
    await unitAged(root, "orphan", now + 1, 2 * HOUR_MS);

    expect(await units.sweep(now + 1)).toEqual({ quarantined: ["orphan"], pruned: [] });
    expect((await readdir(quarantineRoot(root))).toSorted()).toEqual(["orphan", `orphan.${String(now + 1)}`]);
});

test("a database holding no conversation while their directories remain moves nothing: that is a lost database, not a fleet of orphans", async () => {
    const root = await historyRoot();
    const now = Date.now();
    await unitAged(root, "one", now, 2 * HOUR_MS);
    await unitAged(root, "two", now, 30 * 24 * HOUR_MS);

    expect(await conversationUnits(root, owning([])).sweep(now)).toEqual({ held: "database-empty", quarantined: [], pruned: [] });
    expect((await readdir(conversationsRoot(root))).toSorted()).toEqual(["one", "two"]);
    await expect(readdir(quarantineRoot(root))).rejects.toThrow("ENOENT");
});

test("a database made again this boot moves nothing, and removes nothing set aside before it", async () => {
    const root = await historyRoot();
    const now = Date.now();
    // Set aside by an earlier boot, long enough ago that a trusted sweep would remove it now.
    const earlier = now - QUARANTINE_MS - 1;
    await unitAged(root, "owned", earlier, 2 * HOUR_MS);
    await unitAged(root, "orphan", earlier, 2 * HOUR_MS);
    await conversationUnits(root, owning(["owned"])).sweep(earlier);
    await unitAged(root, "stranger", now, 2 * HOUR_MS);

    expect(await conversationUnits(root, owning(["owned"], true)).sweep(now)).toEqual({ held: "database-recreated", quarantined: [], pruned: [] });
    expect((await readdir(conversationsRoot(root))).toSorted()).toEqual(["owned", "stranger"]);
    expect(await readdir(quarantineRoot(root))).toEqual(["orphan"]);
});

test("prune removes what was set aside past its keeping and moves nothing aside, under the sweep's own holds", async () => {
    const root = await historyRoot();
    const now = Date.now();
    await unitAged(root, "owned", now, 2 * HOUR_MS);
    await unitAged(root, "orphan", now, 2 * HOUR_MS);
    await conversationUnits(root, owning(["owned"])).sweep(now);
    await unitAged(root, "stranger", now, 2 * HOUR_MS);
    const later = now + QUARANTINE_MS + 1;

    expect(await conversationUnits(root, owning(["owned"], true)).prune(later)).toEqual({ held: "database-recreated", quarantined: [], pruned: [] });
    expect(await conversationUnits(root, owning([])).prune(later)).toEqual({ held: "database-empty", quarantined: [], pruned: [] });
    expect(await readdir(quarantineRoot(root))).toEqual(["orphan"]);
    expect(await conversationUnits(root, owning(["owned"])).prune(now + QUARANTINE_MS)).toEqual({ quarantined: [], pruned: [] });
    expect(await conversationUnits(root, owning(["owned"])).prune(later)).toEqual({ quarantined: [], pruned: ["orphan"] });
    expect(await readdir(quarantineRoot(root))).toEqual([]);
    // The unowned directory standing is the boot's to move, not prune's.
    expect((await readdir(conversationsRoot(root))).toSorted()).toEqual(["owned", "stranger"]);
});

test("a volume with no units yet sweeps nothing rather than failing boot", async () => {
    expect(await conversationUnits(await historyRoot(), owning([])).sweep(Date.now())).toEqual({ quarantined: [], pruned: [] });
});

test("files lists the first ones by path under the unit with their sizes, and how many there are in all", async () => {
    const root = await historyRoot();
    const units = conversationUnits(root, owning(["c1"]));
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
