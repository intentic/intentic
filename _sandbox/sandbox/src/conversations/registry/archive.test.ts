import { IN_MEMORY } from "@intentic/base/sqlite";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { openConversationsDb } from "../../store/conversations-db.js";
import { beginTurn, fakeTurns, fleetStoreOver } from "../../testing.js";
import type { BeginTurn } from "../actor/conversation-decide.js";
import { createFleet, type FleetStore } from "./agents-registry.js";
import { type PersistedAgent, worktreeOf } from "./agents-store.js";
import { archivable, archivableByAge, archiveAgents, purgeArchived, sweepAgedAgents } from "./archive.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { memoryWatchJournal } from "../../agent/verification/watch-journal.js";
import { armWatcher, listWatchers, startWatcherRuntime } from "../../agent/verification/watchers.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const DAY = 24 * 60 * 60 * 1000;

// The real store on an in-memory database, seeded with `initial`.
const memoryStore = (initial: PersistedAgent[] = []): FleetStore => {
    const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
    store.agents.save(initial);
    return store;
};

const turn = (overrides: Partial<BeginTurn> = {}): BeginTurn => ({
    conversationId: "c1",
    isolated: true,
    prompt: "Fix the login bug",
    profile: { agent: "claude", harness: "native" },
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
const noStandings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };
const noPresences = { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) };

// Only `retire` and `remove` are exercised; the rest of the interface is unreachable from these paths.
const stubWorktrees = (
    retire = jest.fn(async () => undefined),
    remove = jest.fn(async () => undefined),
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
        // Parked on an armed watch: waiting for its wake, not finished.
        expect(archivable(card({ status: "idle", watches: [{ id: "watch-k3f9", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] }))).toBe(false);
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const { worktrees, retire } = stubWorktrees();

        const { archived, failed } = await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(archived).toEqual(["c1"]);
        expect(failed).toEqual([]);
        expect(retire).toHaveBeenCalledWith("c1", worktreeOf(agents.entry("c1"))?.repos, "Fix the login bug");
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("disarms the conversation's watches along with its checkout", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        const stop = startWatcherRuntime({
            logger,
            runCheck: async () => ({ exitCode: 1, output: "" }),
            turns: fakeTurns().turns,
            sessionIdOf: () => undefined,
            journal: memoryWatchJournal(),
            envOf: async () => ({}),
            conversationLive: () => true,
            conversations,
        });
        try {
            await agents.init();
            await beginTurn(conversations, turn(), 1_000);
            await conversations.send("c1", { kind: "settle" }, 2_000).settled;
            await armWatcher({ conversationId: "c1", command: "false", note: "CI", cwd: "/", env: {}, profile: {} });
            expect(listWatchers("c1")).toHaveLength(1);
            await archiveAgents({ agents, conversations, agentWorktrees: stubWorktrees().worktrees, logger }, ["c1"], 9_000);
            expect(listWatchers("c1")).toEqual([]);
        } finally {
            stop();
        }
    });

    it("archives a workspace conversation without calling worktree teardown", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn({ isolated: false }), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const { worktrees, retire } = stubWorktrees();

        expect((await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1"], 9_000)).archived).toEqual(["c1"]);
        expect(retire).not.toHaveBeenCalled();
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("leaves an agent ON the board when its checkout could not be retired", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ conversationId: "c2" }), 1_000);
        await conversations.send("c2", { kind: "settle" }, 2_000).settled;
        const retire = jest.fn(async (id: string) => {
            if (id === "c1") {
                throw new Error("worktree busy");
            }
        });
        const { worktrees } = stubWorktrees(retire as never);

        const { archived, failed } = await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1", "c2"], 9_000);

        // Failure leaves the card rather than losing track of it.
        expect(archived).toEqual(["c2"]);
        // Reported, not just logged: 'nothing moved' would read to the board as nothing to archive.
        expect(failed).toEqual([{ id: "c1", reason: "worktree busy" }]);
        expect(agents.get("c1")?.archivedAt).toBeUndefined();
        expect(agents.list().map((agent) => agent.id)).toEqual(["c1"]);
    });

    it("ignores ids with no entry", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        const { worktrees, retire } = stubWorktrees();
        expect(await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["ghost"], 9_000)).toEqual({
            archived: [],
            failed: [],
        });
        expect(retire).not.toHaveBeenCalled();
    });
});

describe("purgeArchived", () => {
    it("deletes the archive and leaves the board alone", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn({ conversationId: "filed" }), 1_000);
        await conversations.send("filed", { kind: "settle" }, 2_000).settled;
        await beginTurn(conversations, turn({ conversationId: "onboard" }), 1_000);
        await conversations.send("onboard", { kind: "settle" }, 2_000).settled;
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        const repos = worktreeOf(agents.entry("filed"))?.repos;
        const purgeConversationState = jest.fn(async () => {});

        const removed = await purgeArchived({ agents, conversations, agentWorktrees: worktrees, logger, purgeConversationState });

        expect(removed).toEqual(["filed"]);
        // Removes the branch too, unlike archive; torn down against the entry's own recorded composition.
        expect(remove).toHaveBeenCalledWith("filed", repos);
        expect(purgeConversationState).toHaveBeenCalledWith([expect.objectContaining({ id: "filed" })], [expect.objectContaining({ id: "onboard" })]);
        expect(agents.get("filed")).toBeUndefined();
        expect(agents.listArchived()).toEqual([]);
        expect(agents.list().map((agent) => agent.id)).toEqual(["onboard"]);
    });

    it("purges a workspace conversation without attempting branch removal", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn({ isolated: false }), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(await purgeArchived({ agents, conversations, agentWorktrees: worktrees, logger })).toEqual(["c1"]);
        expect(remove).not.toHaveBeenCalled();
        expect(agents.get("c1")).toBeUndefined();
    });

    it("keeps the agents whose teardown failed, and deletes the rest", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        for (const id of ["a", "b"]) {
            await beginTurn(conversations, turn({ conversationId: id }), 1_000);
            await conversations.send(id, { kind: "settle" }, 2_000).settled;
        }
        const remove = jest.fn(async (id: string) => {
            if (id === "a") {
                throw new Error("repo locked");
            }
        });
        const { worktrees } = stubWorktrees(undefined, remove as never);
        await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["a", "b"], 9_000);

        const removed = await purgeArchived({ agents, conversations, agentWorktrees: worktrees, logger });

        // Keeps the row rather than losing track of a branch the disk still has.
        expect(removed).toEqual(["b"]);
        expect(agents.listArchived().map((agent) => agent.id)).toEqual(["a"]);
    });

    it("leaves an agent that a new turn took back out of the archive", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn({ conversationId: "filed" }), 1_000);
        await conversations.send("filed", { kind: "settle" }, 2_000).settled;
        const { worktrees, remove } = stubWorktrees();
        await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["filed"], 9_000);
        // A person's door un-archives it before their turn begins, taking the card out of this purge's scope.
        await agents.clearArchived(["filed"]);
        await beginTurn(conversations, turn({ conversationId: "filed" }), 10_000);

        expect(await purgeArchived({ agents, conversations, agentWorktrees: worktrees, logger })).toEqual([]);
        expect(remove).not.toHaveBeenCalled();
    });
});

describe("sweepAgedAgents", () => {
    it("archives only what has aged out, and skips a running turn", async () => {
        const now = 10 * DAY;
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        // Old and finished: the sweep should take this one.
        await beginTurn(conversations, turn({ conversationId: "old" }), 0);
        await conversations.send("old", { kind: "settle" }, now - 5 * DAY).settled;
        // Finished yesterday: too recent to age out.
        await beginTurn(conversations, turn({ conversationId: "recent" }), 0);
        await conversations.send("recent", { kind: "settle" }, now - 1 * DAY).settled;
        // Old but still running: must be skipped despite its age.
        await beginTurn(conversations, turn({ conversationId: "running" }), now - 5 * DAY);
        const { worktrees } = stubWorktrees();

        const archived = await sweepAgedAgents({ agents, conversations, agentWorktrees: worktrees, logger }, now, 3 * DAY);

        expect(archived).toEqual(["old"]);
        expect(
            agents
                .list()
                .map((agent) => agent.id)
                .toSorted(),
        ).toEqual(["recent", "running"]);
    });

    it("does nothing when retention is off", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences);
        await agents.init();
        await beginTurn(conversations, turn(), 0);
        await conversations.send("c1", { kind: "settle" }, 0).settled;
        const { worktrees, retire } = stubWorktrees();

        expect(await sweepAgedAgents({ agents, conversations, agentWorktrees: worktrees, logger }, 100 * DAY, 0)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
    });
});
