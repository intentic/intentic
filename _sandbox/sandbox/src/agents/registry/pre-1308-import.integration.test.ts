import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { SystemPromptDisclosure, TranscriptRow } from "@intentic/sandbox-contract";
import pino from "pino";
import { sqliteTurnCheckpoints, type TurnCheckpoint } from "../../agent/checkpoints/turn-checkpoints.js";
import { filePromptRecord } from "../../agent/prompt/prompt-record.js";
import { sqliteTurnJournal } from "../../agent/run/turn/turn-journal.js";
import { sqliteWatchJournal } from "../../agent/verification/watch-journal.js";
import { migrateOnThreads } from "../../sessions/record/record-migration.js";
import { sessionsDir } from "../../sessions/session-store.js";
import { fileTranscriptRecord, legacyTranscriptFile, transcriptFile } from "../../sessions/transcript-record.js";
import { conversationUnit } from "../../store/conversation-units.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { clearNewestRun } from "../../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../../store/state-convergence.js";
import type { StepContext, StructuralStep } from "../../store/state-steps.js";
import { conversationEntry } from "../../testing.js";
import { type Composition, type PersistedAgent, type RepoRecord, sqliteAgentsStore } from "./agents-store.js";
import { importRecordPath, pre1308ImportStep } from "./pre-1308-import.js";

// A history volume as ≤1.307 left it, written by hand from the old formats (c760a6028^), imported into the layout this
// build reads, and read back through this build's own stores.

const logger = pino({ level: "silent" });
const made: string[] = [];

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "pre-1308-import-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "work", "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

const json = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;
const jsonl = (rows: readonly unknown[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

// The step's own view of the disk: what the engine's overlay answers before any step has planned a write.
const onDisk = (roots: StateRoots): StepContext => ({
    roots,
    read: async (path) => readFile(path, "utf8").catch(undefinedIfMissing),
    list: async (dir) => ((await readdir(dir).catch(undefinedIfMissing)) ?? []).toSorted(),
    kind: async (path) => {
        const found = await lstat(path).catch(undefinedIfMissing);
        if (found?.isDirectory() === true) {
            return "directory";
        }
        return found?.isFile() === true ? "file" : undefined;
    },
});

const converge = async (roots: StateRoots, steps: readonly StructuralStep[] = [pre1308ImportStep], version = "1.400.0") =>
    convergeState({ roots, version, logger, mayWrite: true, documents: [], steps });

const DIRECTORY = "(directory)";

// Every entry under a directory, a file by its text and a directory by name alone.
const tree = async (root: string): Promise<Record<string, string>> => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return Object.fromEntries(
        await Promise.all(
            entries.map(async (entry) => {
                const path = join(entry.parentPath, entry.name);
                return [relative(root, path), entry.isFile() ? await readFile(path, "utf8") : DIRECTORY] as const;
            }),
        ),
    );
};

const byId = (left: { readonly id: string }, right: { readonly id: string }): number => left.id.localeCompare(right.id);

const AMBER = "amber-otter-a1b2";
const BRISK = "brisk-heron-c3d4";

// What passes through unchanged, typed as this build's record holds it and spread flat into the old one.
const REPOS: RepoRecord[] = [
    { repo: "root", base: "b".repeat(40), landedTip: "t".repeat(40), landedHead: "h".repeat(40), landedAt: 5, absorbed: 3 },
    { repo: "nested/app", base: "c".repeat(40) },
];
const COMPOSITION: Composition = { persona: "reviewer", repos: ["nested/app"] };
const IDENTITY: PersistedAgent["identity"] = {
    origin: { automationId: "visitor-chat", provider: "webchat" },
    startedBy: "ania@example.com",
    startIn: "apps/web",
    actsAs: "reviewer",
    forkedFrom: { conversationId: "source-1", index: 4, files: "then" },
};
const PROFILE: PersistedAgent["profile"] = {
    provider: "codex",
    harness: "claude-code",
    model: "gpt-5",
    effort: "high",
    thinking: true,
    fast: false,
    account: "acct-2",
};
const PEOPLE: Pick<PersistedAgent["social"], "owner" | "landRequested" | "reactions"> = {
    owner: { email: "ania@example.com", name: "Ania", since: 2 },
    landRequested: { email: "bo@example.com", name: "Bo", at: 8 },
    reactions: [{ emoji: "🚀", email: "bo@example.com", name: "Bo", at: 6 }],
};
const CONFLICTS: NonNullable<PersistedAgent["landing"]["conflicts"]> = [
    { repo: "root", paths: [{ path: "a.ts", reason: "diverged" }], clean: 2, mainBranch: "main" },
];
const UNFINISHED: NonNullable<PersistedAgent["unfinished"]> = { at: 9, steps: { open: 2, total: 5, next: "wire it" }, check: "pnpm verify" };

// An isolated conversation that ran out of allowance, every field the old record could carry filled in.
const amberOld = {
    id: AMBER,
    branch: `agent/${AMBER}`,
    runner: "rig-1",
    repos: REPOS,
    composition: COMPOSITION,
    title: "Fix the fan-out",
    titleSource: "model",
    titleAction: "fix",
    ...PROFILE,
    ...IDENTITY,
    ...PEOPLE,
    sessionId: "sess-a",
    compactedTurn: 3,
    landedSubject: "Fix the fan-out",
    landedNote: "Cards update at once.",
    landedBreaking: "Drops the old route.",
    conflicts: CONFLICTS,
    diffFiles: 3,
    diffInsertions: 40,
    diffDeletions: 2,
    status: "error",
    failure: "spent",
    failureCode: "rate_limit",
    limitResetsAt: 1_900,
    limitHeld: true,
    limitScheduled: true,
    limitMoving: "acct-3",
    autoLand: false,
    limitPolicy: "move",
    outagePolicy: "retry",
    stopPolicy: "wait",
    unfinished: UNFINISHED,
    costUsd: 1.5,
    inputTokens: 100,
    outputTokens: 50,
    turns: 4,
    toolUses: 12,
    subagents: 1,
    createdAt: 1,
    updatedAt: 12,
    seenAt: 11,
    archivedAt: 13,
};
const amberNew: PersistedAgent = {
    id: AMBER,
    placement: { kind: "worktree", branch: `agent/${AMBER}`, runner: "rig-1", repos: REPOS, composition: COMPOSITION },
    identity: IDENTITY,
    profile: PROFILE,
    sessionId: "sess-a",
    compactedTurn: 3,
    // Held and booked were the old process's memory, which its own load dropped.
    ending: { kind: "limited", failure: "spent", resetsAt: 1_900, held: false, scheduled: false },
    unfinished: UNFINISHED,
    postures: { autoLand: false, limit: "move", outage: "retry", stopped: "wait" },
    landing: {
        message: { subject: "Fix the fan-out", note: "Cards update at once.", breaking: "Drops the old route." },
        conflicts: CONFLICTS,
        diff: { files: 3, insertions: 40, deletions: 2 },
    },
    social: { title: { text: "Fix the fan-out", source: "model", action: "fix" }, ...PEOPLE, seenAt: 11 },
    totals: { costUsd: 1.5, inputTokens: 100, outputTokens: 50, turns: 4, toolUses: 12, subagents: 1 },
    createdAt: 1,
    updatedAt: 12,
    archivedAt: 13,
};

// A fenced workspace conversation caught mid-turn, written before the turn counters existed, its title source unknown.
const briskOld = {
    id: BRISK,
    title: "Tidy the ledger",
    titleSource: "robot",
    provider: "claude",
    harness: "native",
    sessionId: "sess-b",
    areas: ["finance"],
    repos: [],
    status: "interrupted",
    costUsd: 0.25,
    inputTokens: 10,
    outputTokens: 5,
    createdAt: 20,
    updatedAt: 30,
};
const briskNew: PersistedAgent = {
    id: BRISK,
    placement: { kind: "main" },
    identity: { areas: ["finance"] },
    profile: { provider: "claude", harness: "native" },
    sessionId: "sess-b",
    ending: { kind: "interrupted" },
    postures: {},
    landing: {},
    social: { title: { text: "Tidy the ledger", source: "derived" }, reactions: [] },
    totals: { costUsd: 0.25, inputTokens: 10, outputTokens: 5, turns: 0, toolUses: 0, subagents: 0 },
    createdAt: 20,
    updatedAt: 30,
};

const AMBER_ROOT: TurnCheckpoint = { kind: "worktree", repos: [{ repo: "root", base: "b".repeat(40) }] };
const briskTurn = {
    kind: "turn",
    startedAt: 25,
    attempts: 0,
    turn: { prompt: "tidy the ledger", conversationId: BRISK },
    sessionId: "sess-b",
} as const;
const nightlyFire = {
    kind: "automation",
    automationId: "nightly",
    conversationId: "nightly-run-1",
    startedAt: 26,
    attempts: 1,
    payload: "{}",
    title: "Nightly",
} as const;
const ciWatch = {
    id: "watch-ci-1",
    conversationId: AMBER,
    command: "gh run view 1 --exit-status",
    note: "CI run 1",
    intervalMs: 60_000,
    armedAt: 10,
    deadlineAt: 4_000_000_000_000,
    cwd: "/srv/checkout",
    envKeys: ["GH_TOKEN"],
    turn: { agent: "codex", model: "gpt-5", isolated: true },
};
const amberRows: TranscriptRow[] = [
    { role: "user", text: "fix the fan-out", sentAt: 2 },
    { role: "assistant", text: "Fixed." },
];
const briskRows: TranscriptRow[] = [{ role: "user", text: "tidy the ledger", sentAt: 21 }];
const amberPrompt: SystemPromptDisclosure = { at: 7, runtime: "codex", mode: "intentic", base: { kind: "intentic" }, sections: [] };
const SESSION_FILE = join("projects", "work", "sess-b.jsonl");

// Every piece of the layout before 1.308, each at the address ≤1.307 kept it at.
const writeOldLayout = async (history: string, agents: readonly unknown[] = [amberOld, briskOld]): Promise<void> => {
    await put(join(history, "agents.json"), json(agents));
    await put(
        join(history, "turn-checkpoints.json"),
        json({
            // One anchor the old build could not read either: an empty snapshot.
            [BRISK]: { "0": { kind: "tree", snapshot: "snap-b" }, "1": { kind: "tree", snapshot: "" } },
            [AMBER]: { "0": AMBER_ROOT, "2": { kind: "tree", snapshot: "snap-2" } },
            "gone-conversation": { "0": { kind: "tree", snapshot: "snap-9" } },
        }),
    );
    await put(join(history, "turns", `t-${BRISK}.json`), json(briskTurn));
    await put(join(history, "turns", "a-nightly.json"), json(nightlyFire));
    await put(join(history, "watches", "watch-ci-1.json"), json(ciWatch));
    await put(join(history, "transcripts", `${AMBER}.jsonl`), jsonl(amberRows));
    await put(join(history, "transcripts", `${BRISK}.jsonl`), jsonl(briskRows));
    await put(join(history, "system-prompts", `${AMBER}.json`), JSON.stringify(amberPrompt));
    await put(join(history, "sessions", BRISK, SESSION_FILE), '{"type":"summary"}\n');
};

const NOTE = "notes what it settled in pre-1308-import.json";
const FRESH = [
    "imports 2 conversations from agents.json",
    "imports 3 checkpoints from turn-checkpoints.json",
    "imports 1 turn in flight from turns/",
    "imports 1 automation fire in flight from turns/",
    "imports 1 watch from watches/",
    "copies 2 transcripts into conversations/<id>/",
    "copies 1 system prompt into conversations/<id>/",
    "copies 1 fenced session store into conversations/<id>/sessions/",
    NOTE,
];

test("the plan names every import and writes nothing, not even beside the database", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    const before = await tree(roots.history);

    const planned = await pre1308ImportStep.plan(onDisk(roots));

    expect(planned?.changes).toEqual(FRESH);
    expect(planned?.writes).toEqual(new Map());
    const database = conversationsDbPath(roots.history);
    expect(planned?.touches).toEqual([
        database,
        `${database}-wal`,
        `${database}-shm`,
        importRecordPath(roots.history),
        legacyTranscriptFile(roots.history, AMBER),
        transcriptFile(roots.history, AMBER),
        join(conversationUnit(roots.history, AMBER), "system-prompt.json"),
        legacyTranscriptFile(roots.history, BRISK),
        transcriptFile(roots.history, BRISK),
        sessionsDir(roots.history, BRISK),
    ]);
    expect(await tree(roots.history)).toEqual(before);
});

test("the import lands every conversation, row and file where this build's own stores read them, and keeps the old files", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    const before = await tree(roots.history);

    const outcome = await converge(roots);

    expect(outcome.plan?.steps.map(({ change }) => change)).toEqual(FRESH);
    const conversations = openConversationsDb(conversationsDbPath(roots.history));
    expect(sqliteAgentsStore(conversations).load().toSorted(byId)).toEqual([amberNew, briskNew]);
    const checkpoints = sqliteTurnCheckpoints(conversations);
    expect(await checkpoints.all(AMBER)).toEqual(
        new Map<number, TurnCheckpoint>([
            [0, AMBER_ROOT],
            [2, { kind: "tree", snapshot: "snap-2" }],
        ]),
    );
    expect(await checkpoints.all(BRISK)).toEqual(new Map([[0, { kind: "tree", snapshot: "snap-b" }]]));
    expect(await sqliteTurnJournal(conversations).list()).toEqual([briskTurn, nightlyFire]);
    expect(await sqliteWatchJournal(conversations).list()).toEqual([ciWatch]);
    expect(await fileTranscriptRecord(roots.history).read(AMBER)).toEqual(amberRows);
    expect(await fileTranscriptRecord(roots.history).read(BRISK)).toEqual(briskRows);
    expect(await filePromptRecord(roots.history).of(AMBER)).toEqual(amberPrompt);
    expect(await readFile(join(sessionsDir(roots.history, BRISK), SESSION_FILE), "utf8")).toBe('{"type":"summary"}\n');
    // Copied, never moved: a rollback to 1.307 finds every old file as it left it.
    const after = await tree(roots.history);
    expect(Object.fromEntries(Object.keys(before).map((path) => [path, after[path]]))).toEqual(before);
});

test("a second plan finds nothing left to import while the old files stay where they were", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    await converge(roots);

    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();
    expect(JSON.parse(await readFile(importRecordPath(roots.history), "utf8"))).toEqual({ conversations: [AMBER, BRISK], fires: ["nightly"] });
    expect((await readdir(roots.history)).toSorted()).toEqual(
        expect.arrayContaining(["agents.json", "sessions", "system-prompts", "transcripts", "turn-checkpoints.json", "turns", "watches"]),
    );
});

test("an id conversations.db already holds keeps its row, and none of the old conversation's rows or files join it", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    const standing = conversationEntry({ id: AMBER, social: { title: { text: "Started after 1.308", source: "user" }, reactions: [] } });
    const existing = openConversationsDb(conversationsDbPath(roots.history));
    sqliteAgentsStore(existing).save([standing]);
    existing.db.close();

    expect((await pre1308ImportStep.plan(onDisk(roots)))?.changes).toEqual([
        "imports 1 conversation from agents.json",
        "leaves 1 id already in conversations.db untouched",
        "imports 1 checkpoint from turn-checkpoints.json",
        "imports 1 turn in flight from turns/",
        "imports 1 automation fire in flight from turns/",
        "copies 1 transcript into conversations/<id>/",
        "copies 1 fenced session store into conversations/<id>/sessions/",
        NOTE,
    ]);
    await converge(roots);

    const conversations = openConversationsDb(conversationsDbPath(roots.history));
    expect(sqliteAgentsStore(conversations).load().toSorted(byId)).toEqual([standing, briskNew]);
    expect(await sqliteTurnCheckpoints(conversations).all(AMBER)).toEqual(new Map());
    expect(await sqliteWatchJournal(conversations).list()).toEqual([]);
    await expect(stat(legacyTranscriptFile(roots.history, AMBER))).rejects.toThrow("ENOENT");
    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();
});

test("a record this build cannot map is skipped and counted, and the rest still land", async () => {
    const roots = await volumes();
    // A cost that is not a number, an id no path may carry, and an element that is not a record at all.
    await writeOldLayout(roots.history, [{ ...amberOld, costUsd: "a lot" }, briskOld, { ...briskOld, id: "../outside" }, "not a record"]);

    expect((await pre1308ImportStep.plan(onDisk(roots)))?.changes).toEqual([
        "imports 1 conversation from agents.json",
        "skips 3 records in agents.json this build cannot map",
        "imports 1 checkpoint from turn-checkpoints.json",
        "imports 1 turn in flight from turns/",
        "imports 1 automation fire in flight from turns/",
        "copies 1 transcript into conversations/<id>/",
        "copies 1 fenced session store into conversations/<id>/sessions/",
        NOTE,
    ]);
    await converge(roots);

    expect(sqliteAgentsStore(openConversationsDb(conversationsDbPath(roots.history))).load()).toEqual([briskNew]);
    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();
});

test("each status the old record could hold becomes the ending it meant", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history, [
        { ...briskOld, id: "calm-cove-0001", status: "idle" },
        { ...briskOld, id: "calm-cove-0002", status: "stopped" },
        { ...briskOld, id: "calm-cove-0003", status: "error", failure: "provider down", failureCode: "overloaded" },
        // The old schema read a status it did not know as idle.
        { ...briskOld, id: "calm-cove-0004", status: "paused" },
    ]);
    await converge(roots);

    const endings = sqliteAgentsStore(openConversationsDb(conversationsDbPath(roots.history)))
        .load()
        .toSorted(byId)
        .map(({ id, ending }) => [id, ending]);
    expect(endings).toEqual([
        ["calm-cove-0001", { kind: "idle" }],
        ["calm-cove-0002", { kind: "stopped" }],
        ["calm-cove-0003", { kind: "failed", failure: "provider down", code: "overloaded" }],
        ["calm-cove-0004", { kind: "idle" }],
    ]);
});

test("a history volume without the old layout has nothing to import", async () => {
    const roots = await volumes();
    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();

    // One that only ever ran 1.308 or later: its database and a conversation's own directory.
    const conversations = openConversationsDb(conversationsDbPath(roots.history));
    sqliteAgentsStore(conversations).save([conversationEntry({ id: BRISK })]);
    conversations.db.close();
    await fileTranscriptRecord(roots.history).append(BRISK, briskRows);
    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();
});

test("a conversation removed after its import is not imported again from the files still there", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    await converge(roots);

    const conversations = openConversationsDb(conversationsDbPath(roots.history));
    sqliteAgentsStore(conversations).remove([AMBER]);
    await sqliteTurnJournal(conversations).clearFire("nightly");
    conversations.db.close();
    await rm(conversationUnit(roots.history, AMBER), { recursive: true, force: true });

    expect(await pre1308ImportStep.plan(onDisk(roots))).toBeUndefined();
});

test("a crash after the rows and before the record settles on the next boot with the record alone", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    await converge(roots);
    const record = await readFile(importRecordPath(roots.history), "utf8");
    await rm(importRecordPath(roots.history));

    const planned = await pre1308ImportStep.plan(onDisk(roots));

    expect(planned?.changes).toEqual([
        "leaves 2 ids already in conversations.db untouched",
        "leaves 1 automation fire already in conversations.db untouched",
        NOTE,
    ]);
    expect(planned?.writes).toEqual(new Map([[importRecordPath(roots.history), record]]));
    expect(planned?.effect).toBeUndefined();
});

test("a database the plan cannot open counts as holding nothing, so the pre-flight still announces the import", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    await put(conversationsDbPath(roots.history), "not a database");

    expect((await pre1308ImportStep.plan(onDisk(roots)))?.changes).toEqual(FRESH);
});

test("a rollback to a build without the import gets the volume back as it was", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    const before = await tree(roots.history);
    // The import's boot dies before it commits, and the build before it boots on the same volumes.
    await converge(roots);
    clearNewestRun();
    const rolledBack = await converge(roots, [], "1.399.0");

    // The database and its two sidecars, the record, the four copies and the two logs the transcripts convert to: each
    // absent before, so each removed.
    expect(rolledBack.restored).toBe(10);
    const after = await tree(roots.history);
    // No file of the import's survives; what stays is the journal and emptied directories, left to the sweep of units.
    expect(Object.entries(after).flatMap(([path, text]) => (path in before || text === DIRECTORY ? [] : [path]))).toEqual(["state-journal.json"]);
    expect(Object.fromEntries(Object.keys(before).map((path) => [path, after[path]]))).toEqual(before);
});

// What this build does to every plain record once boot is done (sessions/record/record-migration.ts).
const migrate = async (history: string) =>
    migrateOnThreads({
        historyRoot: history,
        adopt: fileTranscriptRecord(history).adopt,
        logger,
        indexed: async () => new Map(),
        repin: async () => {},
    });

test("the copies convert to logs like any plain record, and a rollback after that takes the logs too", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    const before = await tree(roots.history);
    await converge(roots);

    expect(await migrate(roots.history)).toMatchObject({ converted: 2, failed: 0 });
    expect(await readdir(conversationUnit(roots.history, BRISK))).toEqual(expect.arrayContaining(["transcript.jsonl.zst"]));
    await expect(stat(legacyTranscriptFile(roots.history, BRISK))).rejects.toThrow("ENOENT");
    expect(await fileTranscriptRecord(roots.history).read(AMBER)).toEqual(amberRows);
    expect(await fileTranscriptRecord(roots.history).read(BRISK)).toEqual(briskRows);

    // The import's boot converts its copies and still dies before it commits.
    clearNewestRun();
    const rolledBack = await converge(roots, [], "1.399.0");

    expect(rolledBack.restored).toBe(10);
    const after = await tree(roots.history);
    // Beside the journal, only the migration's own backups of what it converted stay, which nothing reads.
    expect(Object.entries(after).flatMap(([path, text]) => (path in before || text === DIRECTORY ? [] : [path])).toSorted()).toEqual([
        join("backups", "transcripts", `${AMBER}.jsonl.zst`),
        join("backups", "transcripts", `${BRISK}.jsonl.zst`),
        "state-journal.json",
    ]);
    expect(Object.fromEntries(Object.keys(before).map((path) => [path, after[path]]))).toEqual(before);
});

test("a conversation whose record is already a log keeps it, and no plain copy lands beside it", async () => {
    const roots = await volumes();
    await writeOldLayout(roots.history);
    // A plain record beside a log is converted over it on its next change, taking whatever the log holds past it.
    const logged: TranscriptRow[] = [...amberRows, { role: "user", text: "and the retry", sentAt: 9 }];
    await fileTranscriptRecord(roots.history).append(AMBER, logged);

    const outcome = await converge(roots);

    expect(outcome.plan?.steps.map(({ change }) => change)).toEqual(
        FRESH.map((line) => (line.startsWith("copies 2 transcripts") ? "copies 1 transcript into conversations/<id>/" : line)),
    );
    await expect(stat(legacyTranscriptFile(roots.history, AMBER))).rejects.toThrow("ENOENT");
    expect(await fileTranscriptRecord(roots.history).read(AMBER)).toEqual(logged);
    expect(await fileTranscriptRecord(roots.history).read(BRISK)).toEqual(briskRows);
});
