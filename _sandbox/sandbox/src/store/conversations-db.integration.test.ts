import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTurnCheckpoints } from "../agent/checkpoints/turn-checkpoints.js";
import { sqliteAgentsStore } from "../agents/registry/agents-store.js";
import { conversationEntry, isolatedAgent } from "../testing.js";
import { conversationsDbPath, openConversationsDb } from "./conversations-db.js";

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "conversations-db-"));

test("what one connection wrote is what the next process opens: a restart loses nothing committed", () => {
    const root = historyRoot();
    const before = openConversationsDb(conversationsDbPath(root));
    const entry = isolatedAgent([{ repo: "root", base: "a" }], { id: "kept" });
    sqliteAgentsStore(before).save([entry]);

    const after = openConversationsDb(conversationsDbPath(root));
    expect(sqliteAgentsStore(after).load()).toEqual([entry]);
    // Write-ahead logged, so a reader never waits on a writer.
    expect(after.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
});

test("a snapshot carries every row, and adopting it replaces a conversation of the same id whole", async () => {
    const source = openConversationsDb(conversationsDbPath(historyRoot()));
    const moved = isolatedAgent([{ repo: "root", base: "new" }], { id: "moved" });
    sqliteAgentsStore(source).save([moved, conversationEntry({ id: "only-there" })]);
    await sqliteTurnCheckpoints(source).record("moved", 2, { kind: "tree", snapshot: "s-2" });
    const scratch = mkdtempSync(join(tmpdir(), "conversations-snapshot-"));
    const snapshot = join(scratch, "snapshot.db");
    source.snapshot(snapshot);

    const target = openConversationsDb(conversationsDbPath(historyRoot()));
    const targetAgents = sqliteAgentsStore(target);
    targetAgents.save([
        isolatedAgent(
            [
                { repo: "root", base: "old" },
                { repo: "stale", base: "x" },
            ],
            { id: "moved" },
        ),
        conversationEntry({ id: "only-here" }),
    ]);
    await sqliteTurnCheckpoints(target).record("moved", 9, { kind: "tree", snapshot: "s-9" });
    expect(target.adopt(snapshot)).toEqual(["moved", "only-there"]);

    expect(
        targetAgents
            .load()
            .map((entry) => entry.id)
            .toSorted(),
    ).toEqual(["moved", "only-here", "only-there"]);
    expect(targetAgents.load().find((entry) => entry.id === "moved")).toEqual(moved);
    // The replaced conversation's own rows went with it: only what arrived for it is left.
    expect(await sqliteTurnCheckpoints(target).all("moved")).toEqual(new Map([[2, { kind: "tree", snapshot: "s-2" }]]));
    // One file, standalone: the snapshot needs no WAL beside it to be whole.
    expect(readdirSync(scratch)).toEqual(["snapshot.db"]);
});
