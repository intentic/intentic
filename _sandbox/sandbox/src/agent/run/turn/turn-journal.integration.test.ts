import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAgentsStore } from "../../../conversations/registry/agents-store.js";
import { conversationsDbPath, openConversationsDb } from "../../../store/conversations-db.js";
import { conversationEntry } from "../../../testing.js";
import { sqliteTurnJournal } from "./turn-journal.js";

// What the journal is for: the daemon that dies under a turn is not the one that reads the entry back.
test("a turn and a fire in flight are what the next daemon's boot finds", async () => {
    const root = mkdtempSync(join(tmpdir(), "journal-"));
    const dying = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(dying).save([conversationEntry({ id: "c-1" })]);
    await sqliteTurnJournal(dying).recordTurn({
        kind: "turn",
        turn: { conversationId: "c-1", prompt: "ship it" },
        sessionId: "sess-1",
        startedAt: 10,
        attempts: 0,
    });
    await sqliteTurnJournal(dying).recordFire({
        kind: "automation",
        automationId: "nightly",
        conversationId: "a-nightly-1",
        startedAt: 20,
        attempts: 0,
    });

    const booted = sqliteTurnJournal(openConversationsDb(conversationsDbPath(root)));
    expect(await booted.list()).toEqual([
        { kind: "turn", turn: { conversationId: "c-1", prompt: "ship it" }, sessionId: "sess-1", startedAt: 10, attempts: 0 },
        { kind: "automation", automationId: "nightly", conversationId: "a-nightly-1", startedAt: 20, attempts: 0 },
    ]);
});
