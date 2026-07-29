import type { AgentSummary } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import { createAgentsRegistry, type AgentTurnIdentity } from "./agents-registry.js";
import type { AgentsStore, PersistedAgent } from "./agents-store.js";
import { archivable, archivableByAge, archiveAgents, purgeArchived, sweepAgedAgents } from "./archive.js";
import { createLogger } from "../logger.js";
import type { AgentWorktrees } from "./worktrees.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const DAY = 24 * 60 * 60 * 1000;

const memoryStore = (initial: PersistedAgent[] = []): AgentsStore => {
    let data = initial;
    return { load: async () => data, save: async (agents) => void (data = [...agents]) };
};

const turn = (overrides: Partial<AgentTurnIdentity> = {}): AgentTurnIdentity => ({
    conversationId: "c1",
    prompt: "Fix the login bug",
    provider: "claude",
    harness: "native",
    ...overrides,
});

// The guards read the ROSTER, not the persisted entry — half of what they test for is derived per pass and
// never touches disk (see archive.ts). Only the fields the guards actually look at are filled.
const card = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
    id: "c1",
    status: "landed",
    provider: "claude",
    harness: "native",
    branch: "agent/c1",
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, conflict: false },
    ...overrides,
});

// The registry stub the archive paths drive: they only ever ask it for the roster and write the markers back.
const noStandings = { of: () => "idle" as const, refresh: async () => false, forget: () => {} };

// Only `retire` (archive) and `remove` (purge) are exercised here; the rest of the interface is unreachable
// from these paths.
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
        // The throwaway probe — idle, nothing landed, nothing to lose. The case the Finished lane fills up with.
        expect(archivable(card({ status: "idle" }))).toBe(true);
        // Its worktree is the running turn's live working state, and an awaiting turn is holding a question.
        expect(archivable(card({ status: "running" }))).toBe(false);
        expect(archivable(card({ status: "awaiting" }))).toBe(false);
        // Both sit in the Attention lane asking for something; archiving would hide the question, not answer it.
        expect(archivable(card({ status: "conflict" }))).toBe(false);
        expect(archivable(card({ status: "error" }))).toBe(false);
        /* Held work nobody has landed. This is the one the guards could not see when they read the persisted
         * entry: `ready` is derived per roster now, so an entry-level test would have called this agent idle
         * and swept a delta the user was still deciding about off the board. */
        expect(archivable(card({ status: "ready" }))).toBe(false);
        // A turn the daemon died under. Nobody has seen that it stopped — and it is NOT running, so the guard
        // above cannot be the one that saves it. Sweeping it away unread is the failure this status prevents.
        expect(archivable(card({ status: "interrupted" }))).toBe(false);
        // Already off the board.
        expect(archivable(card({ archivedAt: 1 }))).toBe(false);
    });

    it("ages out on updatedAt, and never when retention is off", () => {
        const now = 10 * DAY;
        expect(archivableByAge(card({ updatedAt: now - 4 * DAY }), now, 3 * DAY)).toBe(true);
        // An agent the user is still talking to keeps resetting its own clock.
        expect(archivableByAge(card({ updatedAt: now - 2 * DAY }), now, 3 * DAY)).toBe(false);
        // "Never" — the sweep is off, and the manual Clear button is the only way the lane empties.
        expect(archivableByAge(card({ updatedAt: 0 }), now, 0)).toBe(false);
        // The age check never overrides the safety guards.
        expect(archivableByAge(card({ status: "error", updatedAt: 0 }), now, 3 * DAY)).toBe(false);
    });
});

describe("archiveAgents", () => {
    it("retires each checkout, then marks the entries", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        await agents.begin(turn(), 1_000);
        await agents.finish("c1", 2_000);
        const { worktrees, retire } = stubWorktrees();

        const archived = await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(archived).toEqual(["c1"]);
        expect(retire).toHaveBeenCalledWith("c1", agents.entry("c1")?.repos, "Fix the login bug");
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("leaves an agent ON the board when its checkout could not be retired", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
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

        const archived = await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["c1", "c2"], 9_000);

        // Better a card that outstayed its welcome than one the board forgot while the disk kept it.
        expect(archived).toEqual(["c2"]);
        expect(agents.get("c1")?.archivedAt).toBeUndefined();
        expect(agents.list().map((agent) => agent.id)).toEqual(["c1"]);
    });

    it("ignores ids with no entry", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        const { worktrees, retire } = stubWorktrees();
        expect(await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["ghost"], 9_000)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
    });
});

describe("purgeArchived", () => {
    it("deletes the archive and leaves the board alone", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        await agents.begin(turn({ conversationId: "filed" }), 1_000);
        await agents.finish("filed", 2_000);
        await agents.begin(turn({ conversationId: "onboard" }), 1_000);
        await agents.finish("onboard", 2_000);
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        const repos = agents.entry("filed")?.repos;

        const removed = await purgeArchived({ agents, agentWorktrees: worktrees, logger });

        expect(removed).toEqual(["filed"]);
        // The worktree remnants AND the branch go — that is what makes this the destructive one, and it is the
        // entry's recorded composition that says which repos to tear down in.
        expect(remove).toHaveBeenCalledWith("filed", repos);
        expect(agents.get("filed")).toBeUndefined();
        expect(agents.listArchived()).toEqual([]);
        expect(agents.list().map((agent) => agent.id)).toEqual(["onboard"]);
    });

    it("keeps the agents whose teardown failed, and deletes the rest", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
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

        // Better a row left in the archive than an entry the registry forgot while the disk kept its branch.
        expect(removed).toEqual(["b"]);
        expect(agents.listArchived().map((agent) => agent.id)).toEqual(["a"]);
    });

    it("leaves an agent that a new turn took back out of the archive", async () => {
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        await agents.begin(turn({ conversationId: "filed" }), 1_000);
        await agents.finish("filed", 2_000);
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        // Messaging an archived agent is how you resume it: begin() clears the marker, so the card is back on
        // the board and out of this purge's scope even though the user pressed Delete while looking at it.
        await agents.begin(turn({ conversationId: "filed" }), 10_000);

        expect(await purgeArchived({ agents, agentWorktrees: worktrees, logger })).toEqual([]);
        expect(remove).not.toHaveBeenCalled();
    });
});

describe("sweepAgedAgents", () => {
    it("archives only what has aged out, and skips a running turn", async () => {
        const now = 10 * DAY;
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        // Old and finished — the sweep's target.
        await agents.begin(turn({ conversationId: "old" }), 0);
        await agents.finish("old", now - 5 * DAY);
        // Finished yesterday — still on the board.
        await agents.begin(turn({ conversationId: "recent" }), 0);
        await agents.finish("recent", now - 1 * DAY);
        // Old, but mid-turn: its worktree is live working state.
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
        const agents = createAgentsRegistry(memoryStore(), noStandings);
        await agents.init();
        await agents.begin(turn(), 0);
        await agents.finish("c1", 0);
        const { worktrees, retire } = stubWorktrees();

        expect(await sweepAgedAgents({ agents, agentWorktrees: worktrees, logger }, 100 * DAY, 0)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
    });
});
