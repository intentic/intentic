import { sqliteAgentsStore } from "../agents/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../testing.js";
import { openConversationsDb } from "./conversations-db.js";
import { IN_MEMORY } from "./sqlite.js";

const count = (db: ReturnType<typeof openConversationsDb>, table: string): number =>
    (db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("the conversations database", () => {
    it("refuses a row keyed by a conversation it does not have", () => {
        const db = openConversationsDb(IN_MEMORY);
        expect(() => db.db.prepare("INSERT INTO checkpoint(conversation_id, message, anchor) VALUES ('nobody', 0, '{}')").run()).toThrow(
            "FOREIGN KEY constraint failed",
        );
        expect(count(db, "checkpoint")).toBe(0);
    });

    it("a transaction that fails halfway leaves nothing it wrote", () => {
        const db = openConversationsDb(IN_MEMORY);
        const store = sqliteAgentsStore(db);
        // The second repo row collides with the first on its key, after the conversation row and one repo row are in.
        const colliding = isolatedAgent(
            [
                { repo: "root", base: "a" },
                { repo: "root", base: "b" },
            ],
            { id: "half" },
        );
        expect(() => store.save([conversationEntry({ id: "first" }), colliding])).toThrow("UNIQUE constraint failed");
        expect(count(db, "conversation")).toBe(0);
        expect(count(db, "conversation_repo")).toBe(0);
    });

    it("a transaction opened inside another joins it: the outer failure takes the inner work back too", () => {
        const db = openConversationsDb(IN_MEMORY);
        const store = sqliteAgentsStore(db);
        expect(() =>
            db.transaction(() => {
                store.save([conversationEntry({ id: "inner" })]);
                throw new Error("the rest of the fact could not be written");
            }),
        ).toThrow("the rest of the fact could not be written");
        expect(store.load()).toEqual([]);
        // And the connection is usable afterwards: no transaction was left open by the failure.
        store.save([conversationEntry({ id: "after" })]);
        expect(store.load().map((entry) => entry.id)).toEqual(["after"]);
    });

    it("refuses asynchronous work, which would let other statements into the open transaction", () => {
        const db = openConversationsDb(IN_MEMORY);
        expect(() => db.transaction(async () => undefined)).toThrow("a transaction's work must be synchronous");
        expect(db.db.isTransaction).toBe(false);
    });

    it("is empty until any table holds a row, a fire with no conversation included", () => {
        const db = openConversationsDb(IN_MEMORY);
        expect(db.empty()).toBe(true);
        db.db.prepare("INSERT INTO fire_journal(automation_id, conversation_id, started_at, attempts) VALUES ('nightly', 'a-1', 1, 0)").run();
        expect(db.empty()).toBe(false);
    });

    it("finds every row naming a conversation by reading the schema, JSON columns read back as values", () => {
        const db = openConversationsDb(IN_MEMORY);
        sqliteAgentsStore(db).save([isolatedAgent([{ repo: "root", base: "a" }], { id: "c1" }), conversationEntry({ id: "c2" })]);
        db.db
            .prepare("INSERT INTO checkpoint(conversation_id, message, anchor) VALUES ('c1', 3, ?)")
            .run(JSON.stringify({ kind: "tree", snapshot: "s" }));
        const rows = db.rowsOf("c1");
        expect(Object.keys(rows).toSorted()).toEqual(["checkpoint", "conversation", "conversation_repo"]);
        expect(rows["checkpoint"]).toEqual([{ conversation_id: "c1", message: 3, anchor: { kind: "tree", snapshot: "s" } }]);
        expect(rows["conversation_repo"]).toEqual([
            { conversation_id: "c1", position: 0, repo: "root", base: "a", landed_tip: null, landed_head: null, landed_at: null, absorbed: null },
        ]);
        expect(db.rowsOf("nobody")).toEqual({});
    });
});
