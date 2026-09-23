import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { conversationEntry, isolatedAgent } from "../../testing.js";
import { sqliteAgentsStore } from "./agents-store.js";

// The store guards the fleet's only record, on the history volume: these are the ways a restart could lose part of it.

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "agents-store-"));

describe("sqliteAgentsStore on disk", () => {
    it("a roster written by one daemon is the roster the next one loads, repos and all", () => {
        const root = historyRoot();
        const roster = [
            isolatedAgent(
                [
                    { repo: "root", base: "a".repeat(40), landedTip: "b".repeat(40) },
                    { repo: "nested", base: "c".repeat(40) },
                ],
                { id: "c1" },
            ),
            conversationEntry({ id: "c2" }),
        ];
        sqliteAgentsStore(openConversationsDb(conversationsDbPath(root))).save(roster);
        expect(sqliteAgentsStore(openConversationsDb(conversationsDbPath(root))).load()).toEqual(roster);
    });

    it("a fresh history volume reads as an empty fleet", () => {
        expect(sqliteAgentsStore(openConversationsDb(conversationsDbPath(historyRoot()))).load()).toEqual([]);
    });

    it("a removal one daemon made is one the next daemon sees", () => {
        const root = historyRoot();
        const first = sqliteAgentsStore(openConversationsDb(conversationsDbPath(root)));
        first.save([conversationEntry({ id: "gone" }), conversationEntry({ id: "kept" })]);
        first.remove(["gone"]);
        expect(sqliteAgentsStore(openConversationsDb(conversationsDbPath(root))).load().map((entry) => entry.id)).toEqual(["kept"]);
    });
});
