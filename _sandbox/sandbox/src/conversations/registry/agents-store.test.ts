import { IN_MEMORY } from "@intentic/base/sqlite";
import { openConversationsDb } from "../../store/conversations-db.js";
import { recordedProblems } from "../../store/manifest/manifest-problems.js";
import { conversationEntry, isolatedAgent } from "../../testing.js";
import { type PersistedAgent, sqliteAgentsStore } from "./agents-store.js";

// The registry's table group on an in-memory database: the same schema and SQL as the file on the history volume.

const fresh = () => {
    const db = openConversationsDb(IN_MEMORY);
    return { db, store: sqliteAgentsStore(db) };
};

// Every optional corner of every nested record filled in, so a round-trip that drops one shows as a difference.
const everything: PersistedAgent = {
    id: "full",
    placement: {
        kind: "worktree",
        branch: "agent/full",
        runner: "rig-1",
        repos: [
            { repo: "root", base: "b".repeat(40), landedTip: "t".repeat(40), landedHead: "h".repeat(40), landedAt: 5, absorbed: 3 },
            { repo: "nested/app", base: "c".repeat(40) },
        ],
        composition: { persona: "reviewer", repos: ["nested/app"] },
    },
    identity: {
        origin: { automationId: "visitor-chat", provider: "webchat" },
        startedBy: "ania@example.com",
        areas: ["finance"],
        startIn: "apps/web",
        actsAs: "reviewer",
        forkedFrom: { conversationId: "source-1", index: 4, files: "then" },
    },
    profile: { provider: "codex", harness: "claude-code", model: "gpt-5", effort: "high", thinking: true, fast: false, account: "acct-2" },
    sessionId: "sess-9",
    compactedTurn: 7,
    ending: { kind: "limited", failure: "spent", resetsAt: 1_900, held: true, scheduled: true, moving: "acct-3" },
    // `check` is no longer written (no check runs when a turn ends), but entries from before still carry it and read.
    unfinished: { at: 9, steps: { open: 2, total: 5, next: "wire it" }, check: "pnpm verify" },
    proof: { at: 10, verification: "failing", check: "pnpm test", unviewed: 2 },
    postures: { autoLand: false, limit: "move", outage: "retry", stopped: "wait" },
    landing: {
        message: { subject: "Fix the fan-out", note: "Cards update at once.", breaking: "Drops the old route." },
        conflicts: [{ repo: "root", paths: [{ path: "a.ts", reason: "diverged" }], clean: 2, mainBranch: "main" }],
        diff: { files: 3, insertions: 40, deletions: 2 },
    },
    social: {
        title: { text: "Fix the fan-out", source: "model", action: "fix" },
        owner: { email: "ania@example.com", name: "Ania", since: 2 },
        landRequested: { email: "bo@example.com", name: "Bo", at: 8 },
        reactions: [
            { emoji: "🚀", email: "bo@example.com", name: "Bo", at: 6 },
            { emoji: "👀", email: "ania@example.com", at: 7 },
        ],
        seenAt: 11,
    },
    totals: { costUsd: 1.5, inputTokens: 100, outputTokens: 50, turns: 4, toolUses: 12, subagents: 1 },
    createdAt: 1,
    updatedAt: 12,
    archivedAt: 13,
};

describe("sqliteAgentsStore", () => {
    it("round-trips every nested record whole, the checkout's repos in their order", () => {
        const { store } = fresh();
        store.save([everything]);
        expect(store.load()).toEqual([everything]);
    });

    it.each([
        ["idle", { kind: "idle" }],
        ["interrupted", { kind: "interrupted" }],
        ["stopped", { kind: "stopped" }],
        ["a coded failure", { kind: "failed", failure: "boom", code: "provider-outage" }],
        ["an uncoded failure with no sentence", { kind: "failed" }],
        ["a spent allowance nobody booked", { kind: "limited", held: false, scheduled: false }],
    ] as const)("round-trips the %s ending", (_case, ending) => {
        const { store } = fresh();
        const entry = conversationEntry({ id: "one", ending });
        store.save([entry]);
        expect(store.load()).toEqual([entry]);
    });

    it("round-trips a shared-tree conversation, which has no repos to store", () => {
        const { db, store } = fresh();
        const entry = conversationEntry({ id: "main-1", social: { reactions: [] } });
        store.save([entry]);
        expect(store.load()).toEqual([entry]);
        expect(db.db.prepare("SELECT count(*) AS n FROM conversation_repo").get()).toEqual({ n: 0 });
    });

    it("a save replaces the checkout's repo rows with the entry's, never merging them", () => {
        const { store } = fresh();
        store.save([
            isolatedAgent(
                [
                    { repo: "root", base: "a" },
                    { repo: "gone", base: "b" },
                ],
                { id: "w" },
            ),
        ]);
        const narrowed = isolatedAgent([{ repo: "root", base: "c", landedTip: "d" }], { id: "w" });
        store.save([narrowed]);
        expect(store.load()).toEqual([narrowed]);
    });

    it("one record this build cannot read costs that record, not the roster", () => {
        const { db, store } = fresh();
        store.save([conversationEntry({ id: "before" }), conversationEntry({ id: "after" })]);
        db.db.prepare("INSERT INTO conversation(id, record) VALUES (?, ?)").run("unreadable", JSON.stringify({ placement: { kind: "main" } }));
        expect(store.load().map((entry) => entry.id)).toEqual(["before", "after"]);
        // Still a registered conversation: its directory is not an orphan's.
        expect(store.has("unreadable")).toBe(true);
        expect(store.has("never")).toBe(false);
    });

    it("a record this build cannot read is reported against the database, and a clean load clears the report", () => {
        const { db, store } = fresh();
        store.save([conversationEntry({ id: "readable" })]);
        db.db.prepare("INSERT INTO conversation(id, record) VALUES (?, ?)").run("unreadable", JSON.stringify({ placement: { kind: "main" } }));
        store.load();
        expect(recordedProblems(IN_MEMORY)).toEqual([
            { kind: "invalidEntry", reason: "rejected", detail: "conversation unreadable: its record does not match what this build expects (identity); it is kept as written" },
        ]);
        store.remove(["unreadable"]);
        store.load();
        expect(recordedProblems(IN_MEMORY)).toEqual([]);
    });

    it("a save by this build keeps the keys a newer build wrote into the record, at any depth", () => {
        const { db, store } = fresh();
        const entry = isolatedAgent([{ repo: "root", base: "a" }], { id: "w" });
        store.save([entry]);
        const stored = JSON.parse((db.db.prepare("SELECT record FROM conversation WHERE id = ?").get("w") as { record: string }).record) as Record<string, unknown>;
        const newer = { ...stored, pinnedBy: "ania", placement: { ...(stored["placement"] as object), sparse: true } };
        db.db.prepare("UPDATE conversation SET record = ? WHERE id = ?").run(JSON.stringify(newer), "w");

        const [loaded] = store.load();
        store.save([{ ...(loaded ?? entry), archivedAt: 20 }]);

        const saved = JSON.parse((db.db.prepare("SELECT record FROM conversation WHERE id = ?").get("w") as { record: string }).record) as Record<string, unknown>;
        expect(saved).toEqual({ ...newer, archivedAt: 20 });
    });

    // The pre-push fix's model role went with the push checks (2026-09-28); a turn a record kept queued on it still runs.
    it("a turn queued on the retired pre-push fix's model role reads back on the pipeline fix's", () => {
        const { db, store } = fresh();
        const queued = <Role extends string>(runRole: Role) => ({
            items: [{ id: "m1", voice: "person" as const, queuedAt: 3, revision: 1, turn: { conversationId: "q", prompt: "fix what the push left", runRole } }],
            revision: 1,
        });
        // A shared-tree conversation's record is the entry less its id, which is the row's key.
        const { id, ...record } = conversationEntry({ id: "q" });
        db.db.prepare("INSERT INTO conversation(id, record) VALUES (?, ?)").run(id, JSON.stringify({ ...record, queue: queued("pre-push-fix") }));

        expect(store.load()).toEqual([conversationEntry({ id: "q", queue: queued("pipeline-fix") })]);
    });

    // Up to 2026-10-06 a queue held one booking for every message in it; each message now carries its own. A record
    // written before that reads back with the one booking copied onto each message it held, so nothing goes earlier.
    it("a queue booked as a whole, as records before per-message bookings kept it, reads back with each message booked", () => {
        const { db, store } = fresh();
        const item = (id: string) => ({ id, voice: "person" as const, queuedAt: 3, revision: 1, turn: { conversationId: "q", prompt: `say ${id}` } });
        const after = { conversationId: "brave-otter-k2", since: 2 };
        const legacy = { items: [item("m1"), item("m2")], revision: 2, paused: "scheduled" as const, until: 90_000 };
        const legacyAfter = { items: [item("m1")], revision: 1, paused: "scheduled" as const, after };
        for (const [id, queue] of [["q", legacy], ["l", legacyAfter]] as const) {
            const { id: _id, ...record } = conversationEntry({ id });
            db.db.prepare("INSERT INTO conversation(id, record) VALUES (?, ?)").run(id, JSON.stringify({ ...record, queue }));
        }

        expect(store.load()).toEqual([
            conversationEntry({
                id: "q",
                queue: {
                    ...legacy,
                    items: [
                        { ...item("m1"), until: 90_000 },
                        { ...item("m2"), until: 90_000 },
                    ],
                },
            }),
            conversationEntry({ id: "l", queue: { ...legacyAfter, items: [{ ...item("m1"), after }] } }),
        ]);
    });

    it("removing a conversation takes every row keyed by it in every table, and nobody else's", () => {
        const { db, store } = fresh();
        store.save([isolatedAgent([{ repo: "root", base: "a" }], { id: "gone" }), isolatedAgent([{ repo: "root", base: "a" }], { id: "kept" })]);
        for (const id of ["gone", "kept"]) {
            db.db.prepare("INSERT INTO checkpoint(conversation_id, message, anchor) VALUES (?, 0, '{}')").run(id);
            db.db.prepare("INSERT INTO turn_journal(conversation_id, started_at, attempts, turn) VALUES (?, 1, 0, '{}')").run(id);
            db.db.prepare("INSERT INTO watch(id, conversation_id, entry) VALUES (?, ?, '{}')").run(`watch-${id}`, id);
        }
        store.remove(["gone"]);
        expect(db.rowsOf("gone")).toEqual({});
        expect(Object.keys(db.rowsOf("kept")).toSorted()).toEqual(["checkpoint", "conversation", "conversation_repo", "turn_journal", "watch"]);
    });
});
