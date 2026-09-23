import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sqliteTurnCheckpoints } from "../../agent/checkpoints/turn-checkpoints.js";
import { filePromptRecord } from "../../agent/prompt/prompt-record.js";
import { sqliteTurnJournal } from "../../agent/run/turn/turn-journal.js";
import { sqliteWatchJournal } from "../../agent/verification/watch-journal.js";
import { createLogger } from "../../logger.js";
import { purgeConversationState } from "../../sessions/conversation-purge.js";
import { sessionsDir } from "../../sessions/session-store.js";
import { fileTranscriptRecord } from "../../sessions/transcript-record.js";
import { conversationUnits } from "../../store/conversation-units.js";
import { type ConversationsDb, conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { beginTurn, fleetStoreOver } from "../../testing.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { createFleet } from "./agents-registry.js";
import { sqliteAgentsStore } from "./agents-store.js";
import { forgetConversations, purgeArchived } from "./archive.js";

// Purge by construction: after a conversation leaves, nothing of it may remain on the history volume or in any table.
// Found by walking the volume and reading every table the schema has, never by listing where things are kept, so a
// store added later that forgets its conversation fails here without this file knowing it exists.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const noStandings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };
const noPresences = { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) };

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Every path under the volume that names the conversation, relative to the volume.
const pathsNaming = async (historyRoot: string, id: string): Promise<string[]> =>
    (await readdir(historyRoot, { recursive: true }))
        .map((path) => relative(historyRoot, join(historyRoot, path)))
        .filter((path) => path.includes(id));

// Every row of every table holding the id in any column.
const rowsNaming = (db: ConversationsDb, id: string): string[] =>
    (db.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).flatMap(
        ({ name }) => {
            const columns = (db.db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).map((column) => column.name);
            const where = columns.map((column) => `"${column}" = ?`).join(" OR ");
            const found = db.db.prepare(`SELECT count(*) AS n FROM "${name}" WHERE ${where}`).get(...columns.map(() => id)) as { n: number };
            return found.n === 0 ? [] : [`${name}: ${found.n}`];
        },
    );

// A daemon on a temp history volume, with every store a conversation writes to over the real files and database.
const daemonOn = async () => {
    const base = await mkdtemp(join(tmpdir(), "purge-"));
    roots.push(base);
    const historyRoot = join(base, "history");
    const workspaceRoot = join(base, "work");
    await mkdir(workspaceRoot, { recursive: true });
    const db = openConversationsDb(conversationsDbPath(historyRoot));
    const units = conversationUnits(historyRoot, sqliteAgentsStore(db).has);
    const { agents, conversations } = createFleet(fleetStoreOver(db, units), noStandings, noPresences);
    await agents.init();
    const deps = {
        agents,
        conversations,
        // Neither path under test reaches a checkout: a workspace conversation owns none.
        agentWorktrees: { remove: async () => undefined } as unknown as AgentWorktrees,
        logger,
        purgeConversationState: (removed: Parameters<typeof purgeConversationState>[2], retained: Parameters<typeof purgeConversationState>[3]) =>
            purgeConversationState(workspaceRoot, historyRoot, removed, retained),
    };
    return { historyRoot, db, agents, conversations, deps };
};

// One conversation's whole life, writing to every store a turn writes to: its registry row, its journal row, a
// checkpoint, an armed watch, its transcript, its prompt record and, fenced, its own runtime session store.
const live = async (daemon: Awaited<ReturnType<typeof daemonOn>>, id: string): Promise<void> => {
    const { historyRoot, db, conversations } = daemon;
    conversations.send(id, { kind: "journalled", entry: { kind: "turn", turn: { conversationId: id, prompt: "go" }, startedAt: 1, attempts: 0 } });
    await beginTurn(conversations, { conversationId: id, isolated: false, prompt: "go", profile: {}, areas: ["finance"] }, 1_000);
    await sqliteTurnCheckpoints(db).record(id, 0, { kind: "tree", snapshot: "s-0" });
    await sqliteWatchJournal(db).record({
        id: `watch-${id}`,
        conversationId: id,
        command: "true",
        note: "n",
        intervalMs: 1,
        armedAt: 1,
        deadlineAt: 2,
        cwd: "/",
        envKeys: [],
        turn: {},
    });
    await fileTranscriptRecord(historyRoot).append(id, [{ role: "user", text: "go" }]);
    await filePromptRecord(historyRoot).record(id, { at: 1_000, runtime: "claude-code", mode: "intentic", base: { kind: "runtime" }, sections: [] });
    await mkdir(join(sessionsDir(historyRoot, id), "projects"), { recursive: true });
    await writeFile(join(sessionsDir(historyRoot, id), "projects", "session.jsonl"), "{}\n");
    await conversations.send(id, { kind: "settle" }, 2_000).settled;
};

test("a discarded conversation leaves nothing on the history volume and no row naming it in any table", async () => {
    const daemon = await daemonOn();
    await live(daemon, "gone-1");
    await live(daemon, "kept-1");
    expect(await pathsNaming(daemon.historyRoot, "gone-1")).not.toEqual([]);
    expect(rowsNaming(daemon.db, "gone-1")).not.toEqual([]);

    const entry = daemon.agents.entry("gone-1");
    if (entry === undefined) {
        throw new Error("the conversation never registered");
    }
    await forgetConversations(daemon.deps, [entry]);

    expect(await pathsNaming(daemon.historyRoot, "gone-1")).toEqual([]);
    expect(rowsNaming(daemon.db, "gone-1")).toEqual([]);
    // Only what it named: the other conversation keeps every row and file it had.
    expect(rowsNaming(daemon.db, "kept-1").toSorted()).toEqual(["checkpoint: 1", "conversation: 1", "turn_journal: 1", "watch: 1"]);
    expect((await pathsNaming(daemon.historyRoot, "kept-1")).toSorted()).toEqual([
        "conversations/kept-1",
        "conversations/kept-1/sessions",
        "conversations/kept-1/sessions/projects",
        "conversations/kept-1/sessions/projects/session.jsonl",
        "conversations/kept-1/system-prompt.json",
        "conversations/kept-1/transcript.jsonl",
    ]);
    expect((await sqliteTurnJournal(daemon.db).list()).map((row) => (row.kind === "turn" ? row.turn.conversationId : row.automationId))).toEqual([
        "kept-1",
    ]);
});

test("emptying the archive purges each archived conversation the same way, and only those", async () => {
    const daemon = await daemonOn();
    await live(daemon, "old-1");
    await live(daemon, "live-1");
    await daemon.agents.setArchived(["old-1"], 3_000);

    expect(await purgeArchived(daemon.deps)).toEqual(["old-1"]);

    expect(await pathsNaming(daemon.historyRoot, "old-1")).toEqual([]);
    expect(rowsNaming(daemon.db, "old-1")).toEqual([]);
    expect(rowsNaming(daemon.db, "live-1")).toContain("conversation: 1");
});
