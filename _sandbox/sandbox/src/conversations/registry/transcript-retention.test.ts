import { IN_MEMORY } from "@intentic/base/sqlite";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { fleetStoreOver } from "./agents-registry.testing.js";
import { noPresences } from "../land/tests/landed-presence.testing.js";
import type { BeginTurn } from "../actor/conversation-decide.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { createFleet, type FleetStore } from "./agents-registry.js";
import { type PersistedAgent, worktreeOf } from "./agents-store.js";
import { agedConversations, deleteAgedConversations, type TranscriptRetentionDeps } from "./transcript-retention.js";

// Transcript retention deletes, so what matters most is what it must never take: anything still running or waiting to,
// and a parent whose child stays. The first suite pins those guards over the roster alone; the second runs the delete
// on a real fleet.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const card = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
    id: "c1",
    status: "landed",
    provider: "claude",
    harness: "native",
    branch: "agent/c1",
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    ...overrides,
});

// The roster and the actors' live view, nothing else: the selection reads no more.
const rosterDeps = (live: readonly AgentSummary[], archived: readonly AgentSummary[] = [], running: readonly string[] = []): TranscriptRetentionDeps =>
    unstubbed<TranscriptRetentionDeps>("retention", {
        agents: unstubbed<TranscriptRetentionDeps["agents"]>("agents", { list: () => [...live], listArchived: () => [...archived] }),
        conversations: unstubbed<TranscriptRetentionDeps["conversations"]>("conversations", {
            running: (id) => running.includes(id),
            turnActive: () => false,
            queued: () => ({ items: [], revision: 1 }),
        }),
    });

describe("agedConversations", () => {
    test("takes a settled conversation past the window, live or archived, and nothing while the window is 0", () => {
        const deps = rosterDeps([card({ id: "old" }), card({ id: "fresh", updatedAt: NOW - DAY })], [card({ id: "filed", archivedAt: 1 })]);
        expect(agedConversations(deps, NOW, 30 * DAY).toSorted()).toEqual(["filed", "old"]);
        expect(agedConversations(deps, NOW, 0)).toEqual([]);
    });

    test("never takes one running, queued, waiting on a person, holding unlanded work or a booked re-run", () => {
        const deps = rosterDeps(
            [
                card({ id: "running" }),
                card({ id: "queued", queue: { items: [{ id: "m1", text: "later", voice: "person", queuedAt: 1, revision: 1 }], revision: 1, paused: "stopped" } }),
                card({ id: "asking", status: "awaiting" }),
                card({ id: "ready", status: "ready" }),
                card({ id: "conflict", status: "conflict" }),
                card({ id: "unsent", unsentAt: 1 }),
                card({ id: "rerun", status: "interrupted", limitScheduled: true }),
                card({ id: "watching", watches: [{ id: "watch-k3f9", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] }),
                card({ id: "stopped", status: "stopped" }),
            ],
            [],
            ["running"],
        );
        expect(agedConversations(deps, NOW, 30 * DAY)).toEqual(["stopped"]);
    });

    test("a parent stays while any child of it stays, and goes with children that go too", () => {
        const deps = rosterDeps([
            card({ id: "parent" }),
            card({ id: "busy-child", startedBy: "agent:parent", status: "running" }),
            card({ id: "other" }),
            card({ id: "done-child", startedBy: "agent:other" }),
        ]);
        expect(agedConversations(deps, NOW, 30 * DAY).toSorted()).toEqual(["done-child", "other"]);
    });
});

const memoryStore = (): FleetStore => fleetStoreOver(openConversationsDb(IN_MEMORY));

const turn = (conversationId: string): BeginTurn => ({
    conversationId,
    isolated: true,
    prompt: "Fix the login bug",
    profile: { agent: "claude", harness: "native" },
});

const noStandings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };

describe("deleteAgedConversations", () => {
    test("deletes an aged conversation whole and leaves a running one untouched", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        await agents.init();
        await beginTurn(conversations, turn("old"), 1_000);
        await conversations.send("old", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn("busy"), 1_000);
        const repos = worktreeOf(agents.entry("old"))?.repos;
        const remove = jest.fn(async () => undefined);
        const purged: string[] = [];
        const purgeConversationState = async (removed: readonly PersistedAgent[]): Promise<void> => {
            purged.push(...removed.map((entry) => entry.id));
        };

        const result = await deleteAgedConversations(
            { agents, conversations, agentWorktrees: unstubbed<AgentWorktrees>("agentWorktrees", { remove }), logger, purgeConversationState },
            2_000 + 40 * DAY,
            30 * DAY,
        );

        expect(result).toEqual({ deleted: ["old"], failed: 0 });
        expect(remove).toHaveBeenCalledWith("old", repos);
        expect(purged).toEqual(["old"]);
        expect(agents.entry("old")).toBeUndefined();
        expect(agents.entry("busy")?.id).toBe("busy");
    });

    test("a checkout that cannot be removed keeps its conversation for the next run", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        await agents.init();
        await beginTurn(conversations, turn("old"), 1_000);
        await conversations.send("old", { kind: "settle" }, 2_000).settled;
        const remove = jest.fn(async () => {
            throw new Error("busy");
        });

        const result = await deleteAgedConversations(
            { agents, conversations, agentWorktrees: unstubbed<AgentWorktrees>("agentWorktrees", { remove }), logger },
            2_000 + 40 * DAY,
            30 * DAY,
        );

        expect(result).toEqual({ deleted: [], failed: 1 });
        expect(agents.entry("old")?.id).toBe("old");
    });
});
