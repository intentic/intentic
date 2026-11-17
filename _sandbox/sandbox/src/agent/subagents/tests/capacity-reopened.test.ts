import { pino } from "pino";
import { waitFor } from "@intentic/testing/bun";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { fakeTurns } from "../../../seams/turn-starter.testing.js";
import { capacityNoticer } from "../capacity-reopened.js";
import { settleChild } from "../child-records.js";
import { noteSpawnedChild, openSpawnedChild, resetSubagents, settleSpawnedChild, waitForSubagent } from "../subagents.js";

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
    settleChild(actors, "sub-1", { status: "failed", report: "", error: "limit", capacity: true });
    // Parked on the other child, so the parent is waiting.
    const parked = waitForSubagent(actors, "parent-1", { target: "sub-2", until: ["finished"], timeoutMs: 1_000 });
    const turns = fakeTurns({ live: true });
    const tell = noticer(turns);
    tell(back);
    tell(back);
    await waitFor(() => expect(turns.steers).toHaveLength(1));
    expect(turns.steers).toHaveLength(1);
    expect(turns.steers[0]?.text).toContain("Capacity is back on claude");
    expect(turns.steers[0]?.text).toContain("`sub-1`");
    settleSpawnedChild(actors, "sub-2", { status: "completed", report: "done" });
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
    expect(turns.steers).toEqual([]);
});

const parentWith = (...children: readonly string[]): void => {
    for (const id of children) {
        openSpawnedChild({ conversationId: "parent-1", conversations: actors, subagentsDir: undefined }, { id, description: id, provider: "claude" });
    }
};

/* 2026-11-17, the shinobi-society audit: five "Capacity is back" notices each cut a parent's 1800 s wait short, for
   children that had failed on a runner's workspace prep, not on capacity. */
test("says nothing of a child that failed for any reason but its provider's capacity", async () => {
    parentWith("sub-prep", "sub-busy");
    settleChild(actors, "sub-prep", { status: "failed", report: "", error: "runner workspace prep failed", capacity: false });
    const parked = waitForSubagent(actors, "parent-1", { target: "sub-busy", until: ["finished"], timeoutMs: 1_000 });
    const turns = fakeTurns({ live: true });
    noticer(turns)(back);
    expect(turns.steers).toEqual([]);
    settleSpawnedChild(actors, "sub-busy", { status: "completed", report: "done" });
    await parked;
});

test("names a failed child once per ending, however many accounts come back; a paused one each time", async () => {
    parentWith("sub-limit", "sub-paused", "sub-busy");
    settleChild(actors, "sub-limit", { status: "failed", report: "", error: "limit", capacity: true });
    noteSpawnedChild(actors, "sub-paused", { status: "paused", summary: "Paused, not finished.", error: "limit" });
    const parked = waitForSubagent(actors, "parent-1", { target: "sub-busy", until: ["finished"], timeoutMs: 1_000 });
    const turns = fakeTurns({ live: true });
    const tell = noticer(turns);
    tell(back);
    await waitFor(() => expect(turns.steers).toHaveLength(1));
    tell({ ...back, account: "acct-3", label: "other@example.com" });
    await waitFor(() => expect(turns.steers).toHaveLength(2));
    expect(turns.steers[0]?.text).toContain("children `sub-limit`, `sub-paused`");
    expect(turns.steers[1]?.text).toContain("child `sub-paused` on claude is failed or paused");
    settleSpawnedChild(actors, "sub-busy", { status: "completed", report: "done" });
    await parked;
});
