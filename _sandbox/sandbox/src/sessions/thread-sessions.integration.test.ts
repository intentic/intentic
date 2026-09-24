import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_SESSION_TTL_MS, fileThreadSessionsStore } from "./thread-sessions.js";

// A thread keeps its conversation until it goes quiet or its conversation is archived, over the real file store: only a
// person reopens an archived conversation, so an inbound message must never resume one.

const KEY = "discord:triage:c1";

const storeOver = (archived: ReadonlySet<string>) =>
    fileThreadSessionsStore(join(mkdtempSync(join(tmpdir(), "threads-")), "thread-sessions.json"), (conversationId) => archived.has(conversationId));

test("a thread whose conversation was archived reads as ended, and the next message mints a fresh conversation", async () => {
    const archived = new Set<string>();
    const store = storeOver(archived);
    let minted = 0;
    const mint = (): string => `conv-${(minted += 1)}`;
    await store.open(KEY, mint, CHANNEL_SESSION_TTL_MS, 1_000);
    await store.settle(KEY, "sess-1", 2_000);
    expect(await store.open(KEY, mint, CHANNEL_SESSION_TTL_MS, 3_000)).toStrictEqual({
        conversationId: "conv-1",
        sessionId: "sess-1",
        startedAt: 1_000,
        lastAt: 3_000,
        messages: 2,
    });

    archived.add("conv-1");
    expect(await store.get(KEY, CHANNEL_SESSION_TTL_MS, 4_000)).toBeUndefined();
    expect(await store.open(KEY, mint, CHANNEL_SESSION_TTL_MS, 5_000)).toStrictEqual({ conversationId: "conv-2", startedAt: 5_000, lastAt: 5_000, messages: 1 });
    expect(await store.get(KEY, CHANNEL_SESSION_TTL_MS, 6_000)).toStrictEqual({ conversationId: "conv-2", startedAt: 5_000, lastAt: 5_000, messages: 1 });
});

test("a thread on a conversation still on the board resumes it inside its TTL and ends past it", async () => {
    const store = storeOver(new Set());
    await store.open(KEY, () => "conv-1", CHANNEL_SESSION_TTL_MS, 1_000);
    expect(await store.get(KEY, CHANNEL_SESSION_TTL_MS, 1_000 + CHANNEL_SESSION_TTL_MS)).toMatchObject({ conversationId: "conv-1" });
    expect(await store.get(KEY, CHANNEL_SESSION_TTL_MS, 1_001 + CHANNEL_SESSION_TTL_MS)).toBeUndefined();
});
