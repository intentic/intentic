import { describe, expect, it } from "bun:test";
import { sqliteAgentsStore } from "../../../agents/registry/agents-store.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { IN_MEMORY } from "../../../store/sqlite.js";
import { conversationEntry } from "../../../testing.js";
import { type JournalledFire, type JournalledTurn, sqliteTurnJournal } from "./turn-journal.js";

// The journal's two tables on an in-memory database: a turn's row hangs off its conversation's, a fire's off nothing.

const registered = (...ids: string[]) => {
    const db = openConversationsDb(IN_MEMORY);
    sqliteAgentsStore(db).save(ids.map((id) => conversationEntry({ id })));
    return { db, journal: sqliteTurnJournal(db) };
};

const turn = (over: Partial<JournalledTurn> = {}): JournalledTurn => ({
    kind: "turn",
    turn: { conversationId: "c-1", prompt: "ship it" },
    startedAt: 10,
    attempts: 0,
    ...over,
});

const fire = (over: Partial<JournalledFire> = {}): JournalledFire => ({
    kind: "automation",
    automationId: "nightly",
    conversationId: "a-nightly-1",
    startedAt: 20,
    attempts: 0,
    ...over,
});

describe("sqliteTurnJournal", () => {
    it("both kinds round-trip whole, each under its own key, and clear independently", async () => {
        const { journal } = registered("c-1");
        expect(await journal.list()).toEqual([]);
        const parked = turn({
            sessionId: "sess-1",
            parked: [{ kind: "question", requestId: "q-1", questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "the first" }] }] }],
        });
        await journal.recordTurn(parked);
        await journal.recordFire(fire({ payload: "ping", origin: { automationId: "nightly", provider: "webhook" }, title: "Nightly" }));

        expect(await journal.list()).toEqual([parked, fire({ payload: "ping", origin: { automationId: "nightly", provider: "webhook" }, title: "Nightly" })]);

        await journal.clearTurn("c-1");
        expect((await journal.list()).map((entry) => entry.kind)).toEqual(["automation"]);
        await journal.clearFire("nightly");
        expect(await journal.list()).toEqual([]);
    });

    it("a second turn on the same conversation replaces the row whole, the first one's session with it", async () => {
        const { journal } = registered("c-1");
        await journal.recordTurn(turn({ sessionId: "sess-1" }));
        await journal.recordTurn(turn({ turn: { conversationId: "c-1", prompt: "again" }, startedAt: 30, attempts: 1 }));
        expect(await journal.list()).toEqual([turn({ turn: { conversationId: "c-1", prompt: "again" }, startedAt: 30, attempts: 1 })]);
    });

    it("clearing what isn't there is a no-op: a turn that settles twice must not throw", async () => {
        const { journal } = registered();
        await expect(journal.clearTurn("never-ran")).resolves.toBeUndefined();
        await expect(journal.clearFire("never-fired")).resolves.toBeUndefined();
    });

    it("refuses a turn for a conversation that has no row, and files a fire whose conversation does not exist yet", async () => {
        const { journal } = registered();
        await expect(journal.recordTurn(turn())).rejects.toThrow("FOREIGN KEY constraint failed");
        await journal.recordFire(fire());
        expect(await journal.list()).toEqual([fire()]);
    });

    it("a row this build cannot read is skipped and left, and costs no other entry its resume", async () => {
        const { db, journal } = registered("c-1", "c-2");
        db.db.prepare("INSERT INTO turn_journal(conversation_id, started_at, attempts, turn) VALUES ('c-2', 5, 0, '{}')").run();
        await journal.recordTurn(turn());
        expect(await journal.list()).toEqual([turn()]);
        expect(db.rowsOf("c-2")["turn_journal"]).toEqual([{ conversation_id: "c-2", started_at: 5, attempts: 0, turn: {}, session_id: null, parked: null }]);
    });

    it("goes with its conversation", async () => {
        const { db, journal } = registered("c-1");
        await journal.recordTurn(turn());
        sqliteAgentsStore(db).remove(["c-1"]);
        expect(await journal.list()).toEqual([]);
    });
});
