import type { AgentSummary } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import { createAgentsRegistry, type AgentTurnIdentity } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import { archivable, archivableByAge, archiveAgents, purgeArchived, sweepAgedAgents } from "./archive.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const DAY = 24 * 60 * 60 * 1000;

const memoryStore = (initial: PersistedAgent[] = []): AgentsStore => {
    let data = initial;
    return { load: async () => data, save: async (agents) => void (data = [...agents]) };
};

const turn = (overrides: Partial<AgentTurnIdentity> = {}): AgentTurnIdentity => ({
    conversationId: "c1",
    isolated: true,
    prompt: "Fix the login bug",
    provider: "claude",
    harness: "native",
    ...overrides,
});

// Guards read the roster, not the persisted entry; only the fields they actually look at are filled here.
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

// Archive paths only ever read the roster and write markers back through this stub.
const noStandings = { of: () => "idle" as const, refresh: async () => false, forget: () => {} };
const noPresences = { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) };

// Only `retire` and `remove` are exercised; the rest of the interface is unreachable from these paths.
const stubWorktrees = (
    retire = vi.fn(async () => undefined),
    remove = vi.fn(async () => undefined),
): { worktrees: AgentWorktrees; retire: typeof retire; remove: typeof remove } => ({
    worktrees: { retire, remove } as unknown as AgentWorktrees,
    retire,
    remove,
});

describe("archivable", () => {
    it("takes finished agents and leaves everything that still owes the user an answer", () => {
        expect(archivable(card({ status: "landed" }))).toBe(true);
        // The common case: idle, nothing landed, nothing to lose.
        expect(archivable(card({ status: "idle" }))).toBe(true);
        // A running turn's worktree is live; an awaiting one is holding a question.
        expect(archivable(card({ status: "running" }))).toBe(false);
        expect(archivable(card({ status: "awaiting" }))).toBe(false);
        // Conflict and error sit in Attention; archiving would hide the question, not answer it.
        expect(archivable(card({ status: "conflict" }))).toBe(false);
        expect(archivable(card({ status: "error" }))).toBe(false);
        // `ready` is derived per roster, not stored; an entry-level guard would have called this agent idle.
        expect(archivable(card({ status: "ready" }))).toBe(false);
        // Daemon died mid-turn; not `running`, so sweeping it away unread is what this status prevents.
        expect(archivable(card({ status: "interrupted" }))).toBe(false);
        expect(archivable(card({ archivedAt: 1 }))).toBe(false);
    });

    it("ages out on updatedAt, and never when retention is off", () => {
        const now = 10 * DAY;
        expect(archivableByAge(card({ updatedAt: now - 4 * DAY }), now, 3 * DAY)).toBe(true);
        expect(archivableByAge(card({ updatedAt: now - 2 * DAY }), now, 3 * DAY)).toBe(false);
        expect(archivableByAge(card({ updatedAt: 0 }), now, 0)).toBe(false);
        // Age never overrides the status guards.
        expect(archivableByAge(card({ status: "error", updatedAt: 0 }), now, 3 * DAY)).toBe(false);
    });
});

describe("archiveAgents", () => {
    it("retires each checkout, then marks the entries", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn(), 1_000);
        await agents.finish("c1", 2_000);
        const { worktrees, retire } = stubWorktrees();

        const { archived, failed } = await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(archived).toEqual(["c1"]);
        expect(failed).toEqual([]);
        expect(retire).toHaveBeenCalledWith("c1", agents.entry("c1")?.repos, "Fix the login bug");
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("archives a workspace conversation without calling worktree teardown", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn({ isolated: false }), 1_000);
        await agents.finish("c1", 2_000);
        const { worktrees, retire } = stubWorktrees();

        expect((await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1"], 9_000)).archived).toEqual(["c1"]);
        expect(retire).not.toHaveBeenCalled();
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("leaves an agent ON the board when its checkout could not be retired", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn(), 1_000);
        await agents.finish("c1", 2_000);
        await agents.begin(turn({ conversationId: "c2" }), 1_000);
        await agents.finish("c2", 2_000);
        const retire = vi.fn(async (id: string) => {
            if (id === "c1") {
                throw new Error("worktree busy");
            }
        });
        const { worktrees } = stubWorktrees(retire as never);

        const { archived, failed } = await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1", "c2"], 9_000);

        // Failure leaves the card rather than losing track of it.
        expect(archived).toEqual(["c2"]);
        // Reported, not just logged: 'nothing moved' would read to the board as nothing to archive.
        expect(failed).toEqual([{ id: "c1", reason: "worktree busy" }]);
        expect(agents.get("c1")?.archivedAt).toBeUndefined();
        expect(agents.list().map((agent) => agent.id)).toEqual(["c1"]);
    });

    it("ignores ids with no entry", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        const { worktrees, retire } = stubWorktrees();
        expect(await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["ghost"], 9_000)).toEqual({ archived: [], failed: [] });
        expect(retire).not.toHaveBeenCalled();
    });
});

describe("purgeArchived", () => {
    it("deletes the archive and leaves the board alone", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn({ conversationId: "filed" }), 1_000);
        await agents.finish("filed", 2_000);
        await agents.begin(turn({ conversationId: "onboard" }), 1_000);
        await agents.finish("onboard", 2_000);
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        const repos = agents.entry("filed")?.repos;
        const purgeConversationState = vi.fn(async () => {});

        const removed = await purgeArchived({ agents, agentWorktrees: worktrees, logger, purgeConversationState });

        expect(removed).toEqual(["filed"]);
        // Removes the branch too, unlike archive; torn down against the entry's own recorded composition.
        expect(remove).toHaveBeenCalledWith("filed", repos);
        expect(purgeConversationState).toHaveBeenCalledWith([expect.objectContaining({ id: "filed" })], [expect.objectContaining({ id: "onboard" })]);
        expect(agents.get("filed")).toBeUndefined();
        expect(agents.listArchived()).toEqual([]);
        expect(agents.list().map((agent) => agent.id)).toEqual(["onboard"]);
    });

    it("purges a workspace conversation without attempting branch removal", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn({ isolated: false }), 1_000);
        await agents.finish("c1", 2_000);
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(await purgeArchived({ agents, agentWorktrees: worktrees, logger })).toEqual(["c1"]);
        expect(remove).not.toHaveBeenCalled();
        expect(agents.get("c1")).toBeUndefined();
    });

    it("keeps the agents whose teardown failed, and deletes the rest", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        for (const id of ["a", "b"]) {
            await agents.begin(turn({ conversationId: id }), 1_000);
            await agents.finish(id, 2_000);
        }
        const remove = vi.fn(async (id: string) => {
            if (id === "a") {
                throw new Error("repo locked");
            }
        });
        const { worktrees } = stubWorktrees(undefined, remove as never);
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["a", "b"], 9_000);

        const removed = await purgeArchived({ agents, agentWorktrees: worktrees, logger });

        // Keeps the row rather than losing track of a branch the disk still has.
        expect(removed).toEqual(["b"]);
        expect(agents.listArchived().map((agent) => agent.id)).toEqual(["a"]);
    });

    it("leaves an agent that a new turn took back out of the archive", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn({ conversationId: "filed" }), 1_000);
        await agents.finish("filed", 2_000);
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        // A new turn un-archives via `begin`, taking the card out of this purge's scope.
        await agents.begin(turn({ conversationId: "filed" }), 10_000);

        expect(await purgeArchived({ agents, agentWorktrees: worktrees, logger })).toEqual([]);
        expect(remove).not.toHaveBeenCalled();
    });
});

describe("sweepAgedAgents", () => {
    it("archives only what has aged out, and skips a running turn", async () => {
        const now = 10 * DAY;
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        // Old and finished: the sweep should take this one.
        await agents.begin(turn({ conversationId: "old" }), 0);
        await agents.finish("old", now - 5 * DAY);
        // Finished yesterday: too recent to age out.
        await agents.begin(turn({ conversationId: "recent" }), 0);
        await agents.finish("recent", now - 1 * DAY);
        // Old but still running: must be skipped despite its age.
        await agents.begin(turn({ conversationId: "running" }), now - 5 * DAY);
        const { worktrees } = stubWorktrees();

        const archived = await sweepAgedAgents({ agents, agentWorktrees: worktrees, logger }, now, 3 * DAY);

        expect(archived).toEqual(["old"]);
        expect(
            agents
                .list()
                .map((agent) => agent.id)
                .toSorted(),
        ).toEqual(["recent", "running"]);
    });

    it("does nothing when retention is off", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings, noPresences);
        await agents.init();
        await agents.begin(turn(), 0);
        await agents.finish("c1", 0);
        const { worktrees, retire } = stubWorktrees();

        expect(await sweepAgedAgents({ agents, agentWorktrees: worktrees, logger }, 100 * DAY, 0)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
    });
});
