import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { rename, retype } from "./conversions.js";
import { conversionDigest, defineDocument } from "./documents.js";
import { jsonFile } from "../json-file.js";
import { clearNewestRun } from "../newest-run.js";
import { commitState, convergeState, planState, resetStateStatus, type StateRoots, stateStatus } from "./state-convergence.js";
import { GRACE_MS, readJournal, writeJournal } from "./state-journal.js";
import type { StructuralStep } from "./state-steps.js";

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "state-convergence-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "work", "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
};

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const Settings = z.object({ theme: z.string(), density: z.number().optional() });
const colour = rename("colour", "theme");
const numbered = retype("density", (value): value is string => typeof value === "string", Number, "turns density into a number");
const settingsAt = (history: readonly (typeof colour | typeof numbered)[]) =>
    defineDocument({ path: "evolution/settings.json", schema: Settings, history: [...history] });

test("a document whose conversions change it is written back under an open journal, committed after boot", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { colour: "dark", density: "2", fromNewerBuild: true });

    const documents = [settingsAt([colour, numbered])];
    const digest = conversionDigest(documents, []);
    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps: [] });

    expect(outcome.plan?.digest).toBe(digest);
    expect(outcome.plan?.steps).toEqual([
        { document: "evolution/settings.json", change: "renames colour to theme" },
        { document: "evolution/settings.json", change: "turns density into a number" },
    ]);
    expect(await json(path)).toEqual({ theme: "dark", density: 2, fromNewerBuild: true });
    expect(stateStatus()).toEqual({ journal: "open", engine: 2 });
    const [episode] = (await readJournal(roots.history)).episodes;
    expect(episode).toMatchObject({ state: "open", engine: 2, digest, version: "1.400.0" });
    expect(await json(episode?.entries[0]?.preImage ?? "")).toEqual({ colour: "dark", density: "2", fromNewerBuild: true });
    expect(await json(join(roots.workspace, ".intentic/records/conversions.json"))).toEqual([
        { at: expect.any(Number), version: "1.400.0", engine: 2, digest, steps: outcome.plan?.steps },
    ]);

    await commitState(roots);
    expect(stateStatus()).toEqual({ journal: "none", engine: 2 });
    expect((await readJournal(roots.history)).episodes.map(({ state }) => state)).toEqual(["committed"]);
});

test("a second boot of the same build finds nothing to do and opens no episode", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { theme: "dark" });
    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [settingsAt([colour])], steps: [] });
    expect(outcome.plan?.writes.size).toBe(0);
    expect(stateStatus().journal).toBe("none");
    expect((await readJournal(roots.history)).episodes).toEqual([]);
});

test("a rolled-back build puts back what a newer one converted and never committed", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { theme: "dark", density: "2" });
    // The newer build converts density and dies before its boot finishes, leaving the episode open.
    await convergeState({ roots, version: "1.401.0", logger, mayWrite: true, documents: [settingsAt([colour, numbered])], steps: [] });
    expect(await json(path)).toEqual({ theme: "dark", density: 2 });
    clearNewestRun();

    // The older build knows one conversion fewer.
    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [settingsAt([colour])], steps: [] });
    expect(outcome.restored).toBe(1);
    expect(await json(path)).toEqual({ theme: "dark", density: "2" });
    expect(outcome.plan?.downgrade).toBe(true);
    expect((await readJournal(roots.history)).episodes).toEqual([]);
    expect(await readdir(join(roots.workspace, ".intentic/secrets/converting"))).toEqual([]);
});

test("a newer release that retired a conversion's document is an update, not a downgrade", async () => {
    const roots = await volumes();
    await put(join(roots.workspace, "evolution/settings.json"), { theme: "dark" });
    await put(join(roots.workspace, "evolution/other.json"), { theme: "light" });
    const other = defineDocument({ path: "evolution/other.json", schema: Settings, history: [colour] });
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [settingsAt([colour, numbered]), other], steps: [] });
    await commitState(roots);
    clearNewestRun();

    // The newer release knows fewer conversions than the one before it: a count would call it the older build.
    const outcome = await convergeState({ roots, version: "1.401.0", logger, mayWrite: true, documents: [settingsAt([colour])], steps: [] });
    expect(outcome.plan?.downgrade).toBe(false);
    expect(outcome.plan?.engine).toBe(1);
});

test("an open episode opened before the conversion digest existed is put back, whatever its count", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { colour: "dark" });
    const documents = [settingsAt([colour])];
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps: [] });
    // As a build before the digest wrote it: the same count as this one's, and no digest.
    const journal = await readJournal(roots.history);
    await writeJournal(roots.history, { ...journal, episodes: journal.episodes.map(({ digest: _digest, ...episode }) => episode) });
    clearNewestRun();

    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps: [] });
    expect(outcome.restored).toBe(1);
    // Put back, then converted again by this build under an episode of its own.
    expect(await json(path)).toEqual({ theme: "dark" });
    expect((await readJournal(roots.history)).episodes).toMatchObject([{ state: "open", digest: conversionDigest(documents, []) }]);
});

test("another release with the same conversion set resumes the interrupted episode instead of undoing it", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { colour: "dark" });
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [settingsAt([colour])], steps: [] });
    const [opened] = (await readJournal(roots.history)).episodes;
    clearNewestRun();

    const outcome = await convergeState({ roots, version: "1.401.0", logger, mayWrite: true, documents: [settingsAt([colour])], steps: [] });
    expect(outcome.restored).toBe(0);
    expect((await readJournal(roots.history)).episodes.map(({ id, state }) => `${id} ${state}`)).toEqual([`${opened?.id ?? "no episode"} open`]);
    expect(await json(path)).toEqual({ theme: "dark" });
});

test("an interrupted episode of the same build resumes: it keeps the original pre-images and adds new ones", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    const other = join(roots.workspace, "evolution/other.json");
    const documents = [settingsAt([colour]), defineDocument({ path: "evolution/other.json", schema: Settings, history: [colour] })];
    await put(path, { colour: "dark" });
    // The build converts settings.json and dies before its boot finishes; then a second file needing conversion lands.
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps: [] });
    await put(other, { colour: "light" });
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps: [] });

    const [episode] = (await readJournal(roots.history)).episodes;
    expect(episode?.entries.map((entry) => entry.path)).toEqual([path, other]);
    expect(await json(episode?.entries[0]?.preImage ?? "")).toEqual({ colour: "dark" });
    expect(await json(episode?.entries[1]?.preImage ?? "")).toEqual({ colour: "light" });
    expect(await json(other)).toEqual({ theme: "light" });
});

test("a moved document is copied into place, and the earlier copy is removed only after the grace window", async () => {
    const roots = await volumes();
    const moved = defineDocument({ path: "evolution/personas.json", schema: z.array(z.unknown()), movedFrom: ["evolution/identities.json"] });
    const old = join(roots.workspace, "evolution/identities.json");
    await put(old, [{ id: "a" }]);
    const start = 1_000_000;

    const first = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [moved], steps: [], now: () => start });
    expect(first.plan?.steps).toEqual([{ document: "evolution/personas.json", change: "moves it from evolution/identities.json" }]);
    expect(await json(join(roots.workspace, "evolution/personas.json"))).toEqual([{ id: "a" }]);
    expect(await json(old)).toEqual([{ id: "a" }]);
    await commitState(roots, start);

    const early = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [moved], steps: [], now: () => start + 1000 });
    expect(early.plan?.writes.size).toBe(0);
    const late = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [moved], steps: [], now: () => start + GRACE_MS + 2000 });
    expect(late.plan?.steps).toEqual([{ document: "evolution/personas.json", change: "removes the copy left at evolution/identities.json" }]);
    await expect(readFile(old, "utf8")).rejects.toThrow("ENOENT");
});

test("a directory document moves every entry file", async () => {
    const roots = await volumes();
    const approvals = defineDocument({ path: "evolution/approvals", directory: true, schema: z.object({}), movedFrom: ["evolution/drafts"] });
    await put(join(roots.workspace, "evolution/drafts/one.json"), { a: 1 });
    await put(join(roots.workspace, "evolution/drafts/two.json"), { b: 2 });
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [approvals], steps: [] });
    expect((await readdir(join(roots.workspace, "evolution/approvals"))).toSorted()).toEqual(["one.json", "two.json"]);
});

test("a failing conversion is reported and the rest of the plan still lands", async () => {
    const roots = await volumes();
    const failing = retype(
        "theme",
        (value): value is number => typeof value === "number",
        () => {
            throw new Error("no such theme");
        },
        "converts numbered themes",
    );
    await put(join(roots.workspace, "evolution/bad.json"), { theme: 3 });
    await put(join(roots.workspace, "evolution/settings.json"), { colour: "dark" });
    const outcome = await convergeState({
        roots,
        version: "1.400.0",
        logger,
        mayWrite: true,
        documents: [defineDocument({ path: "evolution/bad.json", schema: Settings, history: [failing] }), settingsAt([colour])],
        steps: [],
    });
    expect(outcome.plan?.failures).toEqual([
        { document: "evolution/bad.json", detail: 'conversion "converts numbered themes" failed: no such theme' },
    ]);
    expect(await json(join(roots.workspace, "evolution/settings.json"))).toEqual({ theme: "dark" });
    expect(await json(join(roots.workspace, "evolution/bad.json"))).toEqual({ theme: 3 });
});

test("a structural step's writes and effect run under the same journal", async () => {
    const roots = await volumes();
    const effects: string[] = [];
    const split: StructuralStep = {
        id: "evolution-split",
        describe: "splits runs out of the manifest",
        plan: async ({ read }) => {
            const manifest = join(roots.workspace, "evolution/manifest.json");
            const text = await read(manifest);
            const parsed = text === undefined ? undefined : (JSON.parse(text) as { runs?: unknown });
            if (parsed?.runs === undefined) {
                return undefined;
            }
            return {
                changes: ["moves runs into their own ledger"],
                writes: new Map([
                    [manifest, `${JSON.stringify({})}\n`],
                    [join(roots.workspace, "evolution/runs.json"), `${JSON.stringify(parsed.runs)}\n`],
                ]),
                effect: () => {
                    effects.push("ran");
                    return Promise.resolve();
                },
            };
        },
    };
    await put(join(roots.workspace, "evolution/manifest.json"), { runs: [1, 2] });
    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [split] });
    expect(outcome.plan?.steps).toEqual([{ document: "evolution-split", change: "moves runs into their own ledger" }]);
    expect(await json(join(roots.workspace, "evolution/runs.json"))).toEqual([1, 2]);
    expect(effects).toEqual(["ran"]);
    const [episode] = (await readJournal(roots.history)).episodes;
    expect(episode?.entries.map(({ preImage }) => preImage === null)).toEqual([false, true]);
});

test("a guest daemon converts nothing and writes nothing", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { colour: "dark" });
    const outcome = await convergeState({ roots, version: "1.400.0", logger, mayWrite: false, documents: [settingsAt([colour])], steps: [] });
    expect(outcome.plan).toBeUndefined();
    expect(await json(path)).toEqual({ colour: "dark" });
});

test("planning alone writes nothing, so the pre-flight can run it over read-only mounts", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    await put(path, { colour: "dark" });
    const plan = await planState({ roots, documents: [settingsAt([colour])], steps: [] });
    expect([...plan.writes.keys()]).toEqual([path]);
    expect(await json(path)).toEqual({ colour: "dark" });
    expect(await readdir(roots.history)).toEqual([]);
});

test("a layout step's rename and a conversion inside the renamed tree both come back on a rollback", async () => {
    const roots = await volumes();
    const layout: StructuralStep = {
        id: "evolution-layout",
        describe: "moves the flat tree into its group",
        phase: "layout",
        plan: async ({ list }) => {
            const old = join(roots.workspace, "flat");
            if ((await list(old)).length === 0) {
                return undefined;
            }
            return { changes: ["moves flat into grouped"], writes: new Map(), renames: new Map([[old, join(roots.workspace, "grouped")]]) };
        },
    };
    const inside = defineDocument({ path: "grouped/settings.json", schema: Settings, history: [colour] });
    await put(join(roots.workspace, "flat/settings.json"), { colour: "dark" });
    await writeFile(join(roots.workspace, "flat/asset.bin"), Buffer.from([0, 255, 1]));

    await convergeState({ roots, version: "1.401.0", logger, mayWrite: true, documents: [inside], steps: [layout] });
    expect(await json(join(roots.workspace, "grouped/settings.json"))).toEqual({ theme: "dark" });
    expect([...(await readFile(join(roots.workspace, "grouped/asset.bin")))]).toEqual([0, 255, 1]);
    await expect(readdir(join(roots.workspace, "flat"))).rejects.toThrow("ENOENT");
    clearNewestRun();

    // A build that knows neither step finds the episode open and undoes it, newest first.
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [] });
    expect(await json(join(roots.workspace, "flat/settings.json"))).toEqual({ colour: "dark" });
    expect([...(await readFile(join(roots.workspace, "flat/asset.bin")))]).toEqual([0, 255, 1]);
    await expect(readdir(join(roots.workspace, "grouped"))).rejects.toThrow("ENOENT");
});

test("a rename's grace window writes both names, lets an older build's edit win, and closes after the grace period", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, "evolution/settings.json");
    const renamed = defineDocument({ path: "evolution/settings.json", schema: Settings, history: [colour] });
    const start = 5_000_000;
    await put(path, { colour: "dark" });
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [renamed], steps: [], now: () => start });
    await commitState(roots, start);
    const file = jsonFile<z.infer<typeof Settings>>(path, { parse: (raw) => Settings.safeParse(raw).data, fallback: () => ({ theme: "light" }), document: renamed });

    // Inside the window every write carries the old name too, for a build that reads only it.
    await file.update((current) => ({ ...current, density: 2 }));
    expect(await json(path)).toEqual({ theme: "dark", colour: "dark", density: 2 });

    // A rolled-back build edited the old name: inside the window that is the newer value.
    await put(path, { theme: "dark", colour: "blue", density: 2 });
    expect(await file.read()).toEqual({ theme: "blue", density: 2 });

    // Past the window, the next boot closes it and writes carry only the current name.
    await convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [renamed], steps: [], now: () => start + GRACE_MS + 1 });
    await file.update((current) => ({ ...current, density: 3 }));
    expect(await json(path)).toEqual({ theme: "dark", density: 3 });
});
