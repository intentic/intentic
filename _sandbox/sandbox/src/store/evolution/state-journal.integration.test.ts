import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { emptyJournal, type JournalLogger, journalPath, openEpisode, readJournal, writeJournal } from "./state-journal.js";

// The journal is read by every build that boots on this volume, a rolled-back one included: whatever it cannot read of
// it is named and kept, never read as nothing.

const made: string[] = [];
const historyRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "state-journal-"));
    made.push(root);
    await mkdir(root, { recursive: true });
    return root;
};

afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const warnings = (): { seen: string[]; logger: JournalLogger } => {
    const seen: string[] = [];
    return { seen, logger: { warn: (_fields, message) => void seen.push(message) } };
};

const OLD = join(WORKSPACE_ROOT, "old.json");
const readable = { id: "1-1", engine: 3, digest: "aaaa", version: "1.400.0", state: "open", startedAt: 1, entries: [{ path: join(WORKSPACE_ROOT, "a.json"), preImage: null }] };
// What a newer build might write: a state this build has no word for, and a key it does not know.
const newer = { id: "2-2", engine: 4, digest: "bbbb", version: "1.401.0", state: "paused", startedAt: 2, entries: [], resumeAt: 9 };

test("an episode this build cannot read costs that episode alone: logged, kept as written, the rest read", async () => {
    const root = await historyRoot();
    await writeFile(journalPath(root), JSON.stringify({ episodes: [readable, newer], moved: { [OLD]: 5 } }));
    const { seen, logger } = warnings();

    const journal = await readJournal(root, logger);

    expect(journal.episodes.map(({ id }) => id)).toEqual(["1-1"]);
    expect(journal.moved).toEqual({ [OLD]: 5 });
    expect(journal.kept.episodes).toEqual([newer]);
    expect(seen).toEqual(["state: a conversion episode is not one this build can read (a newer build's, or damaged); it is kept as written and not restored"]);

    // A rewrite (this build committing its own episode, say) keeps the one it could not read.
    await writeJournal(root, { ...journal, episodes: [] });
    expect(JSON.parse(await readFile(journalPath(root), "utf8"))).toEqual({ episodes: [newer], moved: { [OLD]: 5 } });
});

test("keys and episode fields this build does not know survive its rewrite", async () => {
    const root = await historyRoot();
    const renames = { "workspace:.intentic/config/settings.json": [{ from: "a", to: "b", until: 10 }] };
    await writeFile(journalPath(root), JSON.stringify({ episodes: [{ ...readable, note: "from a newer build" }], moved: {}, renames }));

    await writeJournal(root, await readJournal(root));

    expect(JSON.parse(await readFile(journalPath(root), "utf8"))).toEqual({ renames, episodes: [{ ...readable, note: "from a newer build" }], moved: {} });
});

test("a journal that is not JSON is logged, read as empty, and set aside by the next write rather than written over", async () => {
    const root = await historyRoot();
    await writeFile(journalPath(root), "{ half a journal");
    const { seen, logger } = warnings();

    const journal = await readJournal(root, logger);
    expect(journal).toEqual({ ...emptyJournal(), damaged: true });
    expect(seen).toHaveLength(1);

    await writeJournal(root, journal);
    await writeJournal(root, journal);
    expect((await readdir(root)).toSorted()).toEqual(["state-journal.json", "state-journal.json.corrupt"]);
    expect(await readFile(join(root, "state-journal.json.corrupt"), "utf8")).toBe("{ half a journal");
});

test("an absent journal is empty, with nothing to say", async () => {
    const { seen, logger } = warnings();
    expect(await readJournal(await historyRoot(), logger)).toEqual(emptyJournal());
    expect(seen).toEqual([]);
});

test("a new episode whose pre-images cannot all be taken leaves none behind and writes no journal", async () => {
    const base = await historyRoot();
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    const copied = join(roots.workspace, "copied.json");
    await writeFile(copied, "{}");
    // A directory where a file is about to be converted: its copy fails after the first one landed.
    const refused = join(roots.workspace, "refused.json");
    await mkdir(refused);
    const work = { renames: new Map<string, string>(), copies: [], writes: [copied, refused], sourceOf: (path: string) => path };

    await expect(openEpisode(roots, emptyJournal(), work, { engine: 1, digest: "aaaa", version: "1.400.0", now: 7 })).rejects.toThrow();

    expect(await readdir(join(roots.workspace, ".intentic/secrets/converting"))).toEqual([]);
    expect(await readJournal(roots.history)).toEqual(emptyJournal());
});
