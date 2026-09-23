import { expect, test } from "bun:test";
import { sqliteAgentsStore } from "../../agents/registry/agents-store.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { IN_MEMORY } from "../../store/sqlite.js";
import { conversationEntry } from "../../testing.js";
import { sqliteTurnCheckpoints, type TurnCheckpoint } from "./turn-checkpoints.js";

const registered = (...ids: string[]) => {
    const db = openConversationsDb(IN_MEMORY);
    sqliteAgentsStore(db).save(ids.map((id) => conversationEntry({ id })));
    return { db, checkpoints: sqliteTurnCheckpoints(db) };
};

const tree = (snapshot: string): TurnCheckpoint => ({ kind: "tree", snapshot });
const worktree: TurnCheckpoint = {
    kind: "worktree",
    repos: [
        { repo: "root", base: "abc" },
        { repo: "nested/app", base: "def" },
    ],
};

test("both kinds of checkpoint round-trip by message, and a re-record at the same message replaces it", async () => {
    const { checkpoints } = registered("c1", "c2");
    await checkpoints.record("c1", 0, tree("s-0"));
    await checkpoints.record("c1", 4, worktree);
    await checkpoints.record("c2", 0, tree("other"));
    await checkpoints.record("c1", 0, tree("s-0-again"));

    expect(await checkpoints.of("c1", 0)).toEqual(tree("s-0-again"));
    expect(await checkpoints.of("c1", 4)).toEqual(worktree);
    expect(await checkpoints.of("c1", 2)).toBeUndefined();
    expect(await checkpoints.all("c1")).toEqual(
        new Map([
            [0, tree("s-0-again")],
            [4, worktree],
        ]),
    );
    expect(await checkpoints.all("nobody")).toEqual(new Map());
});

test("truncating drops the message it names and every later one, only for that conversation", async () => {
    const { checkpoints } = registered("c1", "c2");
    for (const index of [0, 2, 3, 7]) {
        await checkpoints.record("c1", index, tree(`s-${index}`));
    }
    await checkpoints.record("c2", 3, tree("other"));
    await checkpoints.truncate("c1", 3);
    expect([...(await checkpoints.all("c1")).keys()]).toEqual([0, 2]);
    expect([...(await checkpoints.all("c2")).keys()]).toEqual([3]);
});

// No count caps them: a conversation's checkpoints last exactly as long as the conversation.
test("keep every message a long conversation had, and go with the conversation", async () => {
    const { db, checkpoints } = registered("long");
    for (let index = 0; index < 600; index += 1) {
        await checkpoints.record("long", index, tree(`s-${index}`));
    }
    expect((await checkpoints.all("long")).size).toBe(600);
    await expect(checkpoints.record("never-registered", 0, tree("s"))).rejects.toThrow("FOREIGN KEY constraint failed");
    sqliteAgentsStore(db).remove(["long"]);
    expect((await checkpoints.all("long")).size).toBe(0);
});
