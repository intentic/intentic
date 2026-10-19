import { unstubbed } from "@intentic/testing";
import { isolatedAgent } from "./agents-store.testing.js";
import { IN_MEMORY } from "@intentic/base/sqlite";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { openConversationsDb } from "../../store/conversations-db.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { fakeTurns } from "../../seams/turn-starter.testing.js";
import { fleetStoreOver } from "./agents-registry.testing.js";
import { noPresences } from "../land/tests/landed-presence.testing.js";
import type { BeginTurn } from "../actor/conversation-decide.js";
import { createFleet, type FleetStore } from "./agents-registry.js";
import { type PersistedAgent, worktreeOf } from "./agents-store.js";
import {
    type AgentArchiveDeps,
    sweepHeldCheckouts,
    heldCheckoutByAge,
    agedFamilies,
    archivable,
    archivableByAge,
    archiveAgents,
    goesWithParent,
    purgeArchived,
    sweepAgedAgents,
} from "./archive.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import type { ChildRecord } from "../../agent/subagents/children.js";
import { memoryWatchJournal } from "../../store/journals/watch-journal.js";
import { armWatcher, cancelWatchersFor, listWatchers, startWatcherRuntime } from "../../agent/verification/watchers.js";

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
// The engine as archiving reads it: only the watches a conversation armed, which this suite arms.
const watchEngine = { familyOf: () => ({ heads: [], members: [], records: new Map() }), cancelFamily: async () => [], cancelWatchersFor };

const noStandings = { of: () => "idle" as const, causesOf: () => [], refresh: async () => false, forget: () => {} };

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
        // A message booked for later, or held, is work still to come: archiving would drop it.
        const waiting = { items: [{ id: "m1", text: "after the auth refactor lands", voice: "person" as const, queuedAt: 1, revision: 1 }], revision: 1 };
        expect(archivable(card({ status: "idle", queue: { ...waiting, paused: "scheduled", after: "brave-otter" } }))).toBe(false);
        // Booked on the message itself, as every window now reads it.
        const booked = { items: waiting.items.map((item) => ({ ...item, until: 9_000 })), revision: 1, paused: "scheduled" as const, until: 9_000 };
        expect(archivable(card({ status: "idle", queue: booked }))).toBe(false);
        expect(archivable(card({ status: "idle", queue: { ...waiting, paused: "stopped" } }))).toBe(false);
        expect(archivable(card({ status: "idle", queue: { items: [], revision: 2 } }))).toBe(true);
    });

    it("ages out on updatedAt, and never when retention is off", () => {
        const now = 10 * DAY;
        expect(archivableByAge(card({ updatedAt: now - 4 * DAY }), now, 3 * DAY)).toBe(true);
        expect(archivableByAge(card({ updatedAt: now - 2 * DAY }), now, 3 * DAY)).toBe(false);
        expect(archivableByAge(card({ updatedAt: 0 }), now, 0)).toBe(false);
        // Age never overrides the status guards.
        expect(archivableByAge(card({ status: "error", updatedAt: 0 }), now, 3 * DAY)).toBe(false);
    });

    it("never ages out a conversation a composer still holds an unsent message for", () => {
        const now = 10 * DAY;
        expect(archivableByAge(card({ updatedAt: 0, unsentAt: 1 }), now, 3 * DAY)).toBe(false);
        // The board's own Clear still may: a person pressing it has decided.
        expect(archivable(card({ updatedAt: 0, unsentAt: 1 }))).toBe(true);
    });
});

// A family ages out together: every ending of a child reaches its parent, so a child that stopped before its parent
// last moved is news the parent already had, and left behind it would stand alone in Attention once the parent is filed.
describe("agedFamilies", () => {
    const now = 10 * DAY;
    const child = (id: string, parent: string, overrides: Partial<AgentSummary> = {}): AgentSummary =>
        card({ id, startedBy: `agent:${parent}`, status: "error", updatedAt: 2 * DAY, ...overrides });
    const parent = card({ id: "p", updatedAt: 5 * DAY });

    it("files a landed parent with the children whose stops it moved past, every generation", () => {
        const fleet = [
            parent,
            child("spent", "p", { failureCode: "rate_limit" }),
            child("stopped", "p", { status: "stopped" }),
            child("grand", "spent", { status: "interrupted", updatedAt: 1 * DAY }),
            card({ id: "else", updatedAt: 9 * DAY }),
        ];
        expect(agedFamilies(fleet, now, 3 * DAY).toSorted()).toEqual(["grand", "p", "spent", "stopped"]);
    });

    it("leaves a child that still waits on something, or stopped after its parent last moved", () => {
        const none = card().attention;
        expect(goesWithParent(child("late", "p", { updatedAt: 6 * DAY }), parent)).toBe(false);
        expect(goesWithParent(child("asks", "p", { status: "awaiting", attention: { ...none, question: true } }), parent)).toBe(false);
        expect(goesWithParent(child("needs", "p", { status: "idle", attention: { ...none, need: true } }), parent)).toBe(false);
        expect(goesWithParent(child("held", "p", { status: "ready" }), parent)).toBe(false);
        expect(goesWithParent(child("refused", "p", { status: "conflict" }), parent)).toBe(false);
        expect(goesWithParent(child("broke", "p", { landFailure: { reason: "fatal: refused", at: 1 } }), parent)).toBe(false);
        expect(goesWithParent(child("booked", "p", { failureCode: "rate_limit", limitScheduled: true }), parent)).toBe(false);
        expect(goesWithParent(child("words", "p", { unsentAt: 1 }), parent)).toBe(false);
        expect(goesWithParent(child("done", "p", { status: "landed" }), parent)).toBe(true);
    });

    it("files no family whose parent has not aged out, and nothing with retention off", () => {
        const fresh = card({ id: "p", updatedAt: 9 * DAY });
        expect(agedFamilies([fresh, child("spent", "p")], now, 3 * DAY)).toEqual([]);
        expect(agedFamilies([parent, child("spent", "p")], now, 0)).toEqual([]);
    });
});

describe("archiveAgents", () => {
    it("retires each checkout, then marks the entries", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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

    // A message booked for later would go out at its time into a conversation it found archived, and be refused there.
    // Filing the conversation away by hand says it is done with: its bookings are cancelled with it, and the words held
    // unbooked (by a stop, a refusal) stay, since they go only when somebody presses for them.
    it("cancels the messages scheduled in a conversation it archives, and keeps the ones held unbooked", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        await agents.init();
        await beginTurn(conversations, turn(), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const item = { id: "m-1", voice: "person", queuedAt: 3_000, turn: { conversationId: "c1", prompt: "then tag it", messageId: "m-1" } } as const;
        await conversations.send("c1", { kind: "queue-scheduled", item, booking: { until: 90_000 } }, 3_000).settled;
        const after = { ...item, id: "m-2", turn: { ...item.turn, prompt: "and the docs", messageId: "m-2" } } as const;
        await conversations.send("c1", { kind: "queue-scheduled", item: after, booking: { after: { conversationId: "c9", since: 3_500 } } }, 3_500).settled;
        const held = { ...item, id: "m-3", turn: { ...item.turn, prompt: "and the readme", messageId: "m-3" } } as const;
        await conversations.send("c1", { kind: "queue-returned", items: [held] }, 4_000).settled;
        const { worktrees, retire } = stubWorktrees();

        const { archived, failed } = await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1"], 9_000);

        expect(archived).toEqual(["c1"]);
        expect(failed).toEqual([]);
        expect(retire).toHaveBeenCalledTimes(1);
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
        expect(conversations.queued("c1").items.map((waiting) => waiting.id)).toEqual(["m-3"]);
        expect(conversations.booked().filter(({ conversationId }) => conversationId === "c1")).toEqual([]);
    });

    it("disarms the conversation's watches along with its checkout", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        const stop = startWatcherRuntime({
            logger,
            runCheck: async () => ({ exitCode: 1, output: "" }),
            turns: fakeTurns().turns,
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
            await archiveAgents({ agents, conversations, agentWorktrees: stubWorktrees().worktrees, logger, turnEngine: watchEngine }, ["c1"], 9_000);
            expect(listWatchers("c1")).toEqual([]);
        } finally {
            stop();
        }
    });

    it("archives a workspace conversation without calling worktree teardown", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        await agents.init();
        await beginTurn(conversations, turn({ isolated: false }), 1_000);
        await conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const { worktrees, retire } = stubWorktrees();

        expect((await archiveAgents({ agents, conversations, agentWorktrees: worktrees, logger }, ["c1"], 9_000)).archived).toEqual(["c1"]);
        expect(retire).not.toHaveBeenCalled();
        expect(agents.get("c1")?.archivedAt).toBe(9_000);
    });

    it("leaves an agent ON the board when its checkout could not be retired", async () => {
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
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
        const { agents, conversations } = createFleet(memoryStore(), noStandings, noPresences());
        await agents.init();
        await beginTurn(conversations, turn(), 0);
        await conversations.send("c1", { kind: "settle" }, 0).settled;
        const { worktrees, retire } = stubWorktrees();

        expect(await sweepAgedAgents({ agents, conversations, agentWorktrees: worktrees, logger }, 100 * DAY, 0)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
    });
});

test("held checkout retention leaves every live, watched, queued or unsent conversation alone", () => {
    const now = 14 * DAY;
    for (const status of ["ready", "error", "interrupted", "conflict"] as const) {
        expect(heldCheckoutByAge(card({ status }), now, now)).toBe(true);
    }
    for (const status of ["running", "awaiting", "landed", "idle"] as const) {
        expect(heldCheckoutByAge(card({ status }), now, now)).toBe(false);
    }
    expect(heldCheckoutByAge(card({ status: "ready" }), now, 0)).toBe(false);
    expect(heldCheckoutByAge(card({ status: "ready", updatedAt: 1 }), now, now)).toBe(false);
    expect(heldCheckoutByAge(card({ status: "ready", archivedAt: 1 }), now, now)).toBe(false);
    expect(heldCheckoutByAge(card({ status: "ready", unsentAt: 1 }), now, now)).toBe(false);
    expect(
        heldCheckoutByAge(card({ status: "ready", watches: [{ id: "watch-k3f9", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] }), now, now),
    ).toBe(false);
    expect(
        heldCheckoutByAge(
            card({ status: "ready", queue: { revision: 1, items: [{ id: "m1", text: "later", voice: "person", queuedAt: 1, revision: 1 }] } }),
            now,
            now,
        ),
    ).toBe(false);
});

test("a held card touched while its checkout is probed is left in place", async () => {
    let current = card({ status: "ready" });
    const retire = jest.fn(async () => undefined);
    const now = 14 * DAY;
    const deps = unstubbed<AgentArchiveDeps>("archive", {
        agents: unstubbed<AgentArchiveDeps["agents"]>("agents", { list: () => [current], entry: () => isolatedAgent([]) }),
        conversations: unstubbed<AgentArchiveDeps["conversations"]>("conversations", { running: () => false }),
        agentWorktrees: unstubbed<AgentWorktrees>("worktrees", {
            presence: async () => {
                current = card({ status: "ready", updatedAt: now });
                return "present";
            },
            retire,
        }),
        logger,
    });
    expect(await sweepHeldCheckouts(deps, now, now, () => 0)).toEqual([]);
    expect(retire).toHaveBeenCalledTimes(0);
});

// The held reclaim's seams, every one a sweep can reach: a quiet `ready` card whose checkout stands, nothing running in
// it unless a case says so.
const heldDeps = (
    overrides: {
        readonly jobs?: number;
        readonly family?: { readonly child: string; readonly running?: boolean; readonly turnRunning?: boolean };
    } = {},
) => {
    const order: string[] = [];
    const retire = jest.fn(async () => {
        order.push("retire");
    });
    const reapConversation = jest.fn(async () => {
        order.push("reap");
    });
    const { family } = overrides;
    // Only the fields the reclaim reads off a supervised child; any other read throws.
    const records = new Map<string, ChildRecord>(
        family?.running === undefined
            ? []
            : [[family.child, unstubbed<ChildRecord>("child", { running: family.running, held: undefined, paused: undefined, pending: undefined })]],
    );
    const deps = unstubbed<AgentArchiveDeps>("archive", {
        agents: unstubbed<AgentArchiveDeps["agents"]>("agents", { list: () => [card({ status: "ready" })], entry: () => isolatedAgent([]) }),
        conversations: unstubbed<AgentArchiveDeps["conversations"]>("conversations", {
            running: (id) => family?.turnRunning === true && id === family.child,
            state: () => undefined,
        }),
        agentWorktrees: unstubbed<AgentWorktrees>("worktrees", { presence: async () => "present", retire }),
        reaper: { reapConversation },
        turns: { stop: async () => ({ stopped: false }) },
        turnEngine: {
            ...watchEngine,
            familyOf: () => ({ heads: ["c1"], members: family === undefined ? [] : [{ child: family.child, parent: "c1" }], records }),
        },
        logger,
    });
    // How many of the card's background commands still run, as the composition counts them (runningJobsOf).
    const runningJobs = (): number => overrides.jobs ?? 0;
    return { deps, retire, reapConversation, order, runningJobs };
};

describe("sweepHeldCheckouts never pulls a checkout out from under live work", () => {
    const now = 14 * DAY;

    it("keeps the checkout while a background command it started still runs", async () => {
        const { deps, retire, reapConversation, runningJobs } = heldDeps({ jobs: 1 });
        expect(await sweepHeldCheckouts(deps, now, now, runningJobs)).toEqual([]);
        expect(retire).not.toHaveBeenCalled();
        expect(reapConversation).not.toHaveBeenCalled();
    });

    it("keeps the checkout while a child it spawned is running, supervised or not", async () => {
        const supervised = heldDeps({ family: { child: "kid", running: true } });
        expect(await sweepHeldCheckouts(supervised.deps, now, now, supervised.runningJobs)).toEqual([]);
        expect(supervised.retire).not.toHaveBeenCalled();
        // Known only from the registry's record of who started whom, with its own turn running.
        const unsupervised = heldDeps({ family: { child: "kid", turnRunning: true } });
        expect(await sweepHeldCheckouts(unsupervised.deps, now, now, unsupervised.runningJobs)).toEqual([]);
        expect(unsupervised.retire).not.toHaveBeenCalled();
    });

    it("reclaims once nothing runs, a finished child included, reaping what is left before the directory goes", async () => {
        const { deps, retire, order, runningJobs } = heldDeps({ family: { child: "kid", running: false } });
        expect(await sweepHeldCheckouts(deps, now, now, runningJobs)).toEqual(["c1"]);
        expect(retire).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["reap", "retire"]);
    });
});
