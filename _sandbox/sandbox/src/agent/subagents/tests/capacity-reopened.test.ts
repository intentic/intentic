import { pino } from "pino";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { fakeTurns } from "../../../seams/turn-starter.testing.js";
import { capacityNoticer } from "../capacity-reopened.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild, waitForSubagent } from "../subagents.js";

/* 2026-10-17: the second Claude account came back while the parent sat in its wait; only a log line said so. */

const actors = memoryFleet().conversations;
const logger = pino({ level: "silent" });
const back = { provider: "claude", account: "acct-2", label: "work@example.com", from: "spent" } as const;

beforeEach(() => resetSubagents(actors));

const noticer = (turns: ReturnType<typeof fakeTurns>, now = () => 0) =>
    capacityNoticer({ conversations: actors, doors: { turns: turns.turns }, profileOf: () => ({ agent: "claude" }), logger, now });

test("tells a parent waiting with a child failed on the provider, once per account per ten minutes", async () => {
    openSpawnedChild(
        { conversationId: "parent-1", conversations: actors, subagentsDir: undefined },
        { id: "sub-1", description: "ws1", provider: "claude" },
    );
    openSpawnedChild(
        { conversationId: "parent-1", conversations: actors, subagentsDir: undefined },
        { id: "sub-2", description: "ws2", provider: "claude" },
    );
    settleSpawnedChild(actors, "sub-1", { status: "failed", report: "", error: "limit" });
    // Parked on the other child, so the parent is waiting.
    const parked = waitForSubagent(actors, "parent-1", { target: "sub-2", until: ["finished"], timeoutMs: 1_000 });
    const turns = fakeTurns({ live: true });
    const tell = noticer(turns);
    tell(back);
    tell(back);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turns.steers).toHaveLength(1);
    expect(turns.steers[0]?.text).toContain("Capacity is back on claude");
    expect(turns.steers[0]?.text).toContain("`sub-1`");
    await parked;
});

test("tells nobody when no parent is waiting, or none has a child out on that provider", async () => {
    const turns = fakeTurns({ live: true });
    noticer(turns)(back);
    openSpawnedChild(
        { conversationId: "parent-1", conversations: actors, subagentsDir: undefined },
        { id: "sub-1", description: "ws1", provider: "kimi" },
    );
    settleSpawnedChild(actors, "sub-1", { status: "failed", report: "", error: "limit" });
    noticer(turns)(back);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turns.steers).toEqual([]);
});
