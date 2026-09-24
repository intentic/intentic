import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, type AgentStatus, RETRY_LADDER_TRIES } from "@intentic/sandbox-contract";
import { pino } from "pino";
import {
    armSupervisor,
    childLedger,
    type ChildSupervisor,
    childSupervisor,
    isSpawnedChild,
    spawnChild,
    supervisorFor,
} from "../../agent/subagents/children.js";
import { listSubagentSessions, subagentEndingReported, waitForSubagent } from "../../agent/subagents/subagents.js";
import {
    type BackgroundJob,
    ENDINGS_KEPT,
    jobStatusPath,
    openBackgroundJob,
    runningJobsOf,
    settledBackgroundJobs,
    sweepJobEnds,
} from "../../agent/tools/background-jobs.js";
import { memoryWatchJournal } from "../../agent/verification/watch-journal.js";
import {
    armWatcher,
    cancelWatcher,
    listWatchers,
    MAX_PER_CONVERSATION,
    restoreWatchers,
    startWatcherRuntime,
    type WatcherRuntime,
    type WatcherSpec,
} from "../../agent/verification/watchers.js";
import type { Services } from "../../composition.js";
import { spawnServices } from "../../harness/spawn-services.testing.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { drivenBy, fakeTurns, fleetStoreOver } from "../../testing.js";
import type { LandedPresences } from "../land/landed-presence.js";
import type { LandStanding, LandStandings } from "../land/standing.js";
import { openConversationsDb } from "../../store/conversations-db.js";
import { IN_MEMORY } from "../../store/sqlite.js";
import { createFleet, type Fleet, type FleetStore } from "../registry/agents-registry.js";
import type { EndingStatus } from "../registry/agents-store.js";
import { liveTurnConversations, turnRunOf } from "./conversation-holdings.js";
import type { ParkedCards, Settled } from "./parked-cards.js";

// A model-based test of the conversation actors: a seeded generator drives long random sequences of lifecycle events
// through a real fleet, and of what conversations hold beside it (parked cards, spawned children, detached runs,
// background jobs, watches) through the doors that file them, while an independent model predicts every card and every
// holding. After each step the two must agree, and the invariants hold: one settle per run, no card parked outside a
// live turn, no resume fired more often than its hold allows, and a disposed conversation leaves nothing behind in any
// index.

// mulberry32: small, seedable, and good enough to walk a state machine.
const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d_2b_79_f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
};

const IDS = ["c1", "c2", "c3"] as const;
type Id = (typeof IDS)[number];
type ParkedKind = "plan" | "question" | "permission";
const STANDINGS: readonly LandStanding[] = ["idle", "ready", "landed", "conflict"];

// The child budget each conversation spawns under, small enough that a walk meets both ceilings.
const AT_ONCE = 2;
const PER_CONVERSATION = 4;

// A job on the registry, as the model follows it.
interface JobModel {
    readonly job: BackgroundJob;
    finished: boolean;
    // Handed to the settle once, as a running job it had to hand to a watch.
    adopted: boolean;
}

// What the registry's runtime rules say a conversation is, kept by hand beside the actor under test.
interface Model {
    exists: boolean;
    isolated: boolean;
    archived: boolean;
    running: boolean;
    rewinds: number;
    stopping: "stopped" | "dismissed" | undefined;
    parked: Map<string, ParkedKind>;
    errored: boolean;
    resuming: boolean;
    // The card shows the land lease from an acquisition until the last release, and a new turn hides it.
    landingShown: boolean;
    entryStatus: EndingStatus;
    standing: LandStanding;
    // Runs settled, which the entry's `turns` must count exactly.
    turns: number;
    // Dispatches the current hold has had; a hold gets one.
    firedThisHold: number;
    // Its child turns, live and lifetime, as the spawn budget counts them.
    seats: { readonly live: number; readonly total: number };
    // Its jobs still on the registry, in the order opened; a finished one stays until a settle hands it out.
    jobs: JobModel[];
    // How its jobs ended, newest last, as far back as the card keeps.
    endings: string[];
    // Its armed watches' ids.
    watches: string[];
    supervisor: ChildSupervisor | undefined;
    // Its detached run, as the port's `run` door started it, until a dispose or a restart takes it.
    run: RunModel;
}

type RunModel = "live" | "finished" | undefined;

const fresh = (): Model => ({
    exists: false,
    isolated: false,
    archived: false,
    running: false,
    rewinds: 0,
    stopping: undefined,
    parked: new Map(),
    errored: false,
    resuming: false,
    landingShown: false,
    entryStatus: "idle",
    standing: "idle",
    turns: 0,
    firedThisHold: 0,
    seats: { live: 0, total: 0 },
    jobs: [],
    endings: [],
    watches: [],
    supervisor: undefined,
    run: undefined,
});

// A card raised through parked-cards.ts, on a conversation or on none.
interface Card {
    readonly requestId: string;
    readonly holder: Id | undefined;
    readonly controller: AbortController;
    readonly settled: Promise<Settled<"question">>;
}

// A child spawned through children.ts, as the model follows it.
interface Child {
    readonly id: string;
    readonly parent: Id;
    running: boolean;
    // Its parent's record of it is gone: the parent was disposed, or the daemon restarted under it.
    forgotten: boolean;
    // Its ending still frees a seat of its parent's: false once those seats went with the parent.
    seated: boolean;
    // A wait already took its ending.
    reported: boolean;
    // Its conversation still holds its run: a restart takes the fleet that held it.
    held: boolean;
}

// The status precedence, restated from the rules rather than read from the code under test.
// Whether it will wake itself: an armed watch, or a job not yet handed out, since no completion notice is read in a walk.
const wakes = (model: Model): boolean => model.watches.length > 0 || model.jobs.some((job) => !job.adopted);

const expectedStatus = (model: Model): AgentStatus => {
    if (model.running) {
        if (model.stopping !== undefined) {
            return model.stopping === "dismissed" ? "dismissing" : "stopping";
        }
        return model.parked.size > 0 ? "awaiting" : "running";
    }
    if (model.resuming) {
        return "resuming";
    }
    if (model.landingShown) {
        return "landing";
    }
    if (model.entryStatus !== "idle") {
        return model.entryStatus;
    }
    if (!model.isolated) {
        return "idle";
    }
    // Ready to land, but not done: a card that will wake itself reads as idle.
    return model.standing === "ready" && wakes(model) ? "idle" : model.standing;
};

// The real store on an in-memory database; one instance outlives the fleets a walk restarts over it, as the file does.
const memoryStore = (): FleetStore => fleetStoreOver(openConversationsDb(IN_MEMORY));

const standingsOf = (models: ReadonlyMap<Id, Model>): LandStandings => ({
    of: (id) => models.get(id as Id)?.standing ?? "idle",
    causesOf: () => [],
    refresh: async () => false,
    forget: () => {},
});

const PRESENCES: LandedPresences = { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) };

const SILENT = pino({ level: "silent" });

// What a card's waiter is handed when its turn dies before anybody answers.
const ABORTED = { kind: "question", requestId: "", cancelled: true } as const;

const CHILD_SPEC = { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", on: "here" } as const;

// A turn as the walk drives it, a child's or a conversation's own run: one tracked edit, left pending so a child's
// ledger holds a call, then parked until the walk lets it end.
const gatedTurn = (gates: Map<string, () => void>): TurnStarter["stream"] =>
    async function* gated(input) {
        const gate = Promise.withResolvers<void>();
        gates.set(input.conversationId ?? "", gate.resolve);
        yield {
            kind: "tool_call",
            id: `edit-${input.conversationId ?? ""}`,
            name: "Edit",
            category: "edit",
            status: "in_progress",
            locations: [{ path: join(WORKSPACE_ROOT, "a.ts") }],
        };
        await gate.promise;
        yield { kind: "done" };
    };

// Past its first check an armed watch waits half an hour, far beyond any walk, so only the walk's own moves change it.
const watchSpec = (conversationId: Id): WatcherSpec => ({
    conversationId,
    command: "ci-status --done",
    note: "CI",
    cwd: WORKSPACE_ROOT,
    env: {},
    profile: {},
    intervalSeconds: 1_800,
    timeoutSeconds: 86_400,
});

// The daemon a spawn and a run see, over one fleet's actors: every turn it runs is the walk's gated one.
const daemonOf = (fleet: Fleet, gates: Map<string, () => void>): Services =>
    drivenBy(spawnServices({ subagentsAtOnce: AT_ONCE, subagentsPerTurn: PER_CONVERSATION }, [], fleet.conversations), gatedTurn(gates));

// What a run reads as: undefined when nothing is held.
const runOf = (fleet: Fleet, conversationId: string): RunModel => {
    const run = turnRunOf(fleet.conversations, conversationId);
    return run === undefined ? undefined : run.done ? "finished" : "live";
};

// Settles every microtask a step started: the async tails of effects (writes, probes) and a lease's release.
const drained = async (): Promise<void> => {
    for (let round = 0; round < 8; round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};

// Drains until `holds` answers true; bounded, so a step that never gets there fails by name rather than hanging.
const until = async (holds: () => boolean, what: string): Promise<void> => {
    for (let round = 0; round < 400 && !holds(); round += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(holds(), what).toBe(true);
};

const park = (kind: ParkedKind, requestId: string): AgentEvent =>
    kind === "plan"
        ? { kind: "plan", requestId, text: "1. go" }
        : kind === "question"
          ? { kind: "question", requestId, questions: [] }
          : { kind: "permission", requestId, toolName: "Bash" };

interface Lease {
    readonly id: Id;
    readonly release: () => void;
    readonly done: Promise<unknown>;
}

// One randomized walk: `steps` events over three conversations and the children they spawn, a restart now and then.
// Answers how many steps it checked, every invariant after each.
const walk = async (seed: number, steps: number): Promise<number> => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    // One of `items`, drawn even when there is none, so a walk's draws never depend on how full its lists are.
    const draw = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
    const models = new Map<Id, Model>(IDS.map((id) => [id, fresh()]));
    const store = memoryStore();
    const gates = new Map<string, () => void>();
    let fleet: Fleet = createFleet(store, standingsOf(models), PRESENCES);
    let daemon = daemonOf(fleet, gates);
    // What the watch check answers, and the journal every daemon of this walk restores watches from.
    const check = { exitCode: 1 };
    const watchJournal = memoryWatchJournal();
    const watcherRuntime = (current: Fleet): WatcherRuntime => ({
        logger: SILENT,
        runCheck: async () => ({ exitCode: check.exitCode, output: "" }),
        // No turn is live to steer, and a wake's fresh turn always starts.
        turns: fakeTurns().turns,
        sessionIdOf: () => undefined,
        journal: watchJournal,
        envOf: async () => ({}),
        conversationLive: (conversationId) => current.agents.entry(conversationId) !== undefined,
        conversations: current.conversations,
    });
    let stopWatchers = startWatcherRuntime(watcherRuntime(fleet));
    await fleet.agents.init();
    let clock = 1_000;
    const leases: Lease[] = [];
    const rewinds: Lease[] = [];
    // Every run's parked cards, as the turn journal would hold them for a restart to restore.
    const journal = new Map<Id, Map<string, ParkedKind>>();
    const raised: Card[] = [];
    const children: Child[] = [];
    const dirs: string[] = [];
    const log: string[] = [];

    const modelOf = (id: Id): Model => models.get(id) as Model;
    const send = async (id: Id, event: Parameters<Fleet["conversations"]["send"]>[1]) => {
        clock += 1_000;
        const delivered = fleet.conversations.send(id, event, clock);
        await delivered.settled;
        return delivered.reply as unknown;
    };

    // Only a person's turn opens an archived conversation; any other is turned away before the mutex is even asked.
    const begin = async (id: Id, isolated: boolean, byPerson: boolean): Promise<void> => {
        const model = modelOf(id);
        const began = await send(id, {
            kind: "begin",
            turn: { conversationId: id, isolated, prompt: "go", profile: { agent: "claude", harness: "native" }, byPerson },
        });
        const expected = model.archived && !byPerson ? "archived" : model.running || model.rewinds > 0 ? "busy" : "begun";
        expect(began).toBe(expected);
        if (expected !== "begun") {
            return;
        }
        if (!model.exists) {
            model.isolated = isolated;
        }
        Object.assign(model, {
            exists: true,
            archived: false,
            running: true,
            stopping: undefined,
            errored: false,
            resuming: false,
            landingShown: false,
        });
        model.parked = new Map();
        model.entryStatus = "interrupted";
        journal.set(id, new Map());
    };

    const settle = async (id: Id): Promise<void> => {
        const model = modelOf(id);
        await send(id, { kind: "settle" });
        if (model.exists) {
            model.entryStatus = model.errored ? "error" : model.running && model.stopping === "stopped" ? "stopped" : "idle";
            model.errored = false;
            model.turns += model.running ? 1 : 0;
        }
        model.running = false;
        model.stopping = undefined;
        model.parked = new Map();
        journal.delete(id);
        // Never running after its settle.
        expect(fleet.conversations.running(id)).toBe(false);
    };

    const frame = async (id: Id, event: AgentEvent): Promise<void> => {
        await send(id, { kind: "frame", frame: event });
    };

    const parkOn = async (id: Id, kind: ParkedKind, requestId: string): Promise<void> => {
        const model = modelOf(id);
        await frame(id, park(kind, requestId));
        if (model.running && model.stopping === undefined) {
            model.parked.set(requestId, kind);
            journal.get(id)?.set(requestId, kind);
        }
    };

    // A child's turn ends; its seat goes back to its parent unless the parent's seats went first.
    const endChild = async (child: Child): Promise<void> => {
        gates.get(child.id)?.();
        gates.delete(child.id);
        await until(
            () =>
                runOf(fleet, child.id) !== "live" &&
                (child.forgotten || childLedger(fleet.conversations).some((kid) => kid.conversationId === child.id && !kid.running)),
            `child ${child.id} ends`,
        );
        await drained();
        child.running = false;
        const parent = modelOf(child.parent);
        if (child.seated) {
            parent.seats = { live: parent.seats.live - 1, total: parent.seats.total };
        }
    };

    // A conversation's own run ends, and stays attachable as done.
    const endRun = async (id: Id): Promise<void> => {
        gates.get(id)?.();
        gates.delete(id);
        await until(() => runOf(fleet, id) === "finished", `run ${id} ends`);
        await drained();
        modelOf(id).run = "finished";
    };

    const endJob = (id: Id, entry: JobModel): void => {
        writeFileSync(jobStatusPath(entry.job), "0\n");
        sweepJobEnds(fleet.conversations);
        entry.finished = true;
        const model = modelOf(id);
        model.endings = [...model.endings, entry.job.id].slice(-ENDINGS_KEPT);
    };

    // A card's waiter, settled by its turn dying rather than by an answer.
    const expectAborted = async (card: Card): Promise<void> => {
        expect(await card.settled).toEqual({ reply: ABORTED, resolved: { kind: "resolved", requestId: card.requestId } });
    };

    // Whatever a dying daemon took with it, let go of first: children and runs end, jobs exit, cards lose their turns.
    const quiesce = async (): Promise<void> => {
        for (const child of children.filter((candidate) => candidate.running)) {
            await endChild(child);
        }
        for (const id of IDS.filter((each) => modelOf(each).run === "live")) {
            await endRun(id);
        }
        for (const id of IDS) {
            for (const entry of modelOf(id).jobs.filter((job) => !job.finished)) {
                endJob(id, entry);
            }
        }
        for (const card of raised.splice(0)) {
            card.controller.abort();
            await expectAborted(card);
        }
        await drained();
    };

    const restart = async (): Promise<void> => {
        // A daemon dies with its leases; their holders never learn it, so only a quiet daemon is restarted here.
        await quiesce();
        stopWatchers();
        fleet = createFleet(store, standingsOf(models), PRESENCES);
        daemon = daemonOf(fleet, gates);
        stopWatchers = startWatcherRuntime(watcherRuntime(fleet));
        await fleet.agents.init();
        // The journal brings a watch back for a conversation that still has an entry: re-armed while its condition is
        // unmet, fired by the restore once it is.
        check.exitCode = random() < 0.5 ? 0 : 1;
        await restoreWatchers();
        await drained();
        for (const child of children) {
            child.forgotten = true;
            child.seated = false;
            child.held = false;
        }
        for (const id of IDS) {
            const model = modelOf(id);
            const wasLive = model.running;
            Object.assign(model, {
                running: false,
                stopping: undefined,
                errored: false,
                resuming: false,
                landingShown: false,
                rewinds: 0,
                firedThisHold: 0,
                seats: { live: 0, total: 0 },
                jobs: [],
                endings: [],
                watches: model.exists && check.exitCode === 1 ? model.watches : [],
                supervisor: undefined,
                run: undefined,
            });
            model.parked = new Map();
            // What the boot does for a turn the journal says was parked: a placeholder begins and raises the same cards.
            const turnCards = journal.get(id);
            journal.delete(id);
            if (wasLive && turnCards !== undefined && turnCards.size > 0) {
                await begin(id, model.isolated, false);
                for (const [requestId, kind] of turnCards) {
                    await parkOn(id, kind, requestId);
                }
            }
        }
        check.exitCode = 1;
    };

    const actions: readonly { readonly name: string; readonly weight: number; readonly run: (id: Id) => Promise<void> }[] = [
        { name: "begin", weight: 6, run: (id) => begin(id, random() < 0.5, random() < 0.5) },
        { name: "park", weight: 6, run: (id) => parkOn(id, pick<ParkedKind>(["plan", "question", "permission"]), `r-${Math.floor(random() * 4)}`) },
        {
            name: "resolve",
            weight: 4,
            run: async (id) => {
                const requestId = `r-${Math.floor(random() * 5)}`;
                await frame(id, { kind: "resolved", requestId });
                modelOf(id).parked.delete(requestId);
                journal.get(id)?.delete(requestId);
            },
        },
        {
            name: "error",
            weight: 4,
            run: async (id) => {
                const kind = pick(["uncoded", "limit", "limit-scheduled", "outage-scheduled", "token-scheduled"] as const);
                const events: Record<typeof kind, AgentEvent> = {
                    uncoded: { kind: "error", message: "the runtime died" },
                    limit: { kind: "error", code: "rate_limit", message: "spent", held: { ran: true } },
                    "limit-scheduled": { kind: "error", code: "rate_limit", message: "spent", autoResume: "scheduled", resetsAt: 9 },
                    "outage-scheduled": { kind: "error", code: "provider-outage", message: "down", autoResume: "scheduled" },
                    "token-scheduled": { kind: "error", code: "claude-token-refused", message: "401", autoResume: "scheduled" },
                };
                await frame(id, events[kind]);
                const comingBack = kind === "outage-scheduled" || kind === "token-scheduled";
                modelOf(id).resuming ||= comingBack;
                modelOf(id).errored ||= !comingBack;
            },
        },
        {
            name: "noise",
            weight: 4,
            run: (id) =>
                frame(
                    id,
                    pick<AgentEvent>([
                        { kind: "delta", text: "hi" },
                        { kind: "usage", costUsd: 0.1, inputTokens: 3 },
                        { kind: "session", sessionId: `s-${id}` },
                        { kind: "tool_call", id: "t", name: "Edit", category: "edit", status: "in_progress" },
                        { kind: "todos", items: [{ content: "a", status: "in_progress" }] },
                    ]),
                ),
        },
        {
            name: "stop",
            weight: 3,
            run: async (id) => {
                const ending = pick(["stopped", "dismissed"] as const);
                await send(id, { kind: "stop", ending });
                const model = modelOf(id);
                if (model.running && model.stopping === undefined) {
                    model.stopping = ending;
                    model.parked = new Map();
                    journal.set(id, new Map());
                }
            },
        },
        // A running turn settles exactly once; a resting one is settled now and then by a manual land.
        { name: "settle", weight: 5, run: async (id) => (modelOf(id).running || random() < 0.2 ? settle(id) : undefined) },
        {
            name: "lease",
            weight: 2,
            run: async (id) => {
                const gate = Promise.withResolvers<void>();
                const done = fleet.conversations.withLandLease(id, () => gate.promise);
                leases.push({ id, release: gate.resolve, done });
                modelOf(id).landingShown = true;
            },
        },
        {
            name: "lease-release",
            weight: 2,
            run: async () => {
                const lease = leases.shift();
                if (lease === undefined) {
                    return;
                }
                lease.release();
                await lease.done;
                if (!leases.some((held) => held.id === lease.id)) {
                    modelOf(lease.id).landingShown = false;
                }
            },
        },
        {
            name: "rewind",
            weight: 1,
            run: async (id) => {
                const gate = Promise.withResolvers<void>();
                const model = modelOf(id);
                const done = fleet.conversations.withRewindLease(id, () => gate.promise);
                if (model.running) {
                    expect(await done).toBeUndefined();
                    return;
                }
                model.rewinds += 1;
                rewinds.push({ id, release: gate.resolve, done });
            },
        },
        {
            name: "rewind-release",
            weight: 1,
            run: async () => {
                const rewind = rewinds.shift();
                if (rewind === undefined) {
                    return;
                }
                rewind.release();
                await rewind.done;
                // The rewind's claim is one flag, so the first release frees the conversation whatever else is queued.
                modelOf(rewind.id).rewinds = 0;
                for (const other of rewinds.filter((held) => held.id === rewind.id)) {
                    rewinds.splice(rewinds.indexOf(other), 1);
                    other.release();
                    await other.done;
                }
            },
        },
        {
            name: "break",
            weight: 3,
            run: async (id) => {
                const input = { prompt: "go", conversationId: id };
                const which = pick(["limit", "stopped", "outage", "auth", "got-somewhere"] as const);
                if (which === "got-somewhere") {
                    await send(id, { kind: "turn-got-somewhere" });
                } else {
                    const remint = which === "auth" ? { remint: { account: "acct", refusedToken: "tok" } } : {};
                    await send(id, { kind: "turn-held", held: { input, reason: which, ran: random() < 0.5, ...remint } });
                    modelOf(id).firedThisHold = 0;
                }
            },
        },
        {
            name: "fire",
            weight: 3,
            run: async (id) => {
                const ladder = random() < 0.5;
                const tries = fleet.conversations.state(id)?.resume.stopTries ?? 0;
                const fired = await send(id, { kind: "held-fired", ladder });
                if (fired === true) {
                    modelOf(id).firedThisHold += 1;
                    // A ladder rung fires only while the ladder has rungs left.
                    expect(!ladder || tries < RETRY_LADDER_TRIES).toBe(true);
                }
            },
        },
        {
            name: "drop",
            weight: 2,
            run: async (id) => {
                const which = pick(["superseded", "ladder-spent", "dropped"] as const);
                if (which === "superseded") {
                    await send(id, { kind: "resume-superseded" });
                } else if (which === "ladder-spent") {
                    await send(id, { kind: "ladder-spent" });
                } else {
                    await send(id, { kind: "resume-dropped" });
                }
            },
        },
        { name: "promise", weight: 1, run: async (id) => void (await send(id, { kind: "resume-promised" }), (modelOf(id).resuming = true)) },
        {
            name: "abandon",
            weight: 2,
            run: async (id) => {
                const model = modelOf(id);
                const over = await send(id, { kind: "resume-abandoned", reason: "not coming" });
                expect(over).toBe(!model.running);
                if (!model.running && model.exists && model.resuming) {
                    model.resuming = false;
                    model.entryStatus = "error";
                }
            },
        },
        { name: "standing", weight: 1, run: async (id) => void (modelOf(id).standing = pick(STANDINGS)) },
        {
            name: "archive",
            weight: 1,
            run: async (id) => {
                const model = modelOf(id);
                if (model.exists && !model.running) {
                    await fleet.agents.setArchived([id], clock);
                    model.archived = true;
                }
            },
        },
        {
            name: "card",
            weight: 3,
            run: async (id) => {
                // A quarter are raised on no conversation, as the runtime's own plan and permission cards are.
                const holder = random() < 0.25 ? undefined : id;
                const controller = new AbortController();
                const { id: requestId, wait } = daemon.cards.create("question", ABORTED, holder);
                raised.push({ requestId, holder, controller, settled: wait(controller.signal) });
            },
        },
        {
            name: "card-answer",
            weight: 2,
            run: async () => {
                const card = draw(raised);
                if (card === undefined) {
                    expect(daemon.cards.resolve({ kind: "question", requestId: "r-nobody-raised", answers: {} })).toBe("missing");
                    return;
                }
                raised.splice(raised.indexOf(card), 1);
                const reply = { kind: "question" as const, requestId: card.requestId, answers: { Which: ["A"] } };
                expect(daemon.cards.resolve(reply)).toBe("settled");
                expect(await card.settled).toEqual({ reply, resolved: { kind: "resolved", requestId: card.requestId, reply } });
                expect(daemon.cards.resolve(reply)).toBe("missing");
            },
        },
        {
            name: "card-abort",
            weight: 1,
            run: async () => {
                const card = draw(raised);
                if (card === undefined) {
                    return;
                }
                raised.splice(raised.indexOf(card), 1);
                card.controller.abort();
                await expectAborted(card);
            },
        },
        {
            name: "supervise",
            weight: 1,
            run: async (id) => {
                const supervisor = childSupervisor(daemon, { conversationId: id, cwd: WORKSPACE_ROOT });
                armSupervisor(fleet.conversations, id, supervisor);
                modelOf(id).supervisor = supervisor;
            },
        },
        {
            name: "spawn",
            weight: 2,
            run: async (id) => {
                const model = modelOf(id);
                const allowed = model.seats.live < AT_ONCE && model.seats.total < PER_CONVERSATION;
                const spawned = await spawnChild(daemon, { conversationId: id, cwd: WORKSPACE_ROOT }, CHILD_SPEC);
                expect(spawned.ok, `a spawn under ${JSON.stringify(model.seats)}`).toBe(allowed);
                if (!spawned.ok) {
                    return;
                }
                model.seats = { live: model.seats.live + 1, total: model.seats.total + 1 };
                children.push({ id: spawned.id, parent: id, running: true, forgotten: false, seated: true, reported: false, held: true });
                await until(() => gates.has(spawned.id), `child ${spawned.id} parks`);
            },
        },
        {
            name: "child-end",
            weight: 2,
            run: async () => {
                const child = draw(children.filter((candidate) => candidate.running));
                if (child !== undefined) {
                    await endChild(child);
                }
            },
        },
        {
            name: "child-report",
            weight: 1,
            run: async () => {
                const child = draw(children.filter((candidate) => !candidate.running));
                if (child === undefined) {
                    return;
                }
                const waited = await waitForSubagent(fleet.conversations, child.parent, { target: child.id, until: ["finished"], timeoutMs: 1_000 });
                expect(waited.outcome).toBe(child.forgotten ? "unknown-target" : "finished");
                child.reported ||= !child.forgotten;
            },
        },
        {
            name: "job",
            weight: 2,
            run: async (id) => {
                const job = openBackgroundJob(
                    { conversationId: id, profile: {}, conversations: fleet.conversations },
                    { command: "pnpm build", session: `agent-${id}` },
                );
                if (job === undefined) {
                    throw new Error("the job dir could not be minted");
                }
                dirs.push(job.dir);
                // What tmux-run writes first; without it the settle would end the job as one that never ran.
                writeFileSync(join(job.dir, "cmd"), "pnpm build\n");
                modelOf(id).jobs.push({ job, finished: false, adopted: false });
            },
        },
        {
            name: "job-end",
            weight: 2,
            run: async (id) => {
                const entry = draw(modelOf(id).jobs.filter((job) => !job.finished));
                if (entry !== undefined) {
                    endJob(id, entry);
                }
            },
        },
        {
            name: "job-settle",
            weight: 1,
            run: async (id) => {
                const model = modelOf(id);
                const settled = settledBackgroundJobs(fleet.conversations, id);
                // Each still running is handed out once, and each finished one leaves; unseen unless handed out before.
                expect(settled.running.map((job) => job.id)).toEqual(
                    model.jobs.filter((job) => !job.finished && !job.adopted).map((job) => job.job.id),
                );
                expect(settled.unseen.map((job) => job.id)).toEqual(
                    model.jobs.filter((job) => job.finished && !job.adopted).map((job) => job.job.id),
                );
                model.jobs = model.jobs.filter((job) => !job.finished);
                for (const job of model.jobs) {
                    job.adopted = true;
                }
            },
        },
        {
            name: "watch",
            weight: 2,
            run: async (id) => {
                const model = modelOf(id);
                const outcome = await armWatcher(watchSpec(id));
                if (model.watches.length >= MAX_PER_CONVERSATION) {
                    expect(outcome.kind).toBe("refused");
                    return;
                }
                if (outcome.kind !== "armed") {
                    throw new Error(`a watch on an unmet condition answered ${outcome.kind}`);
                }
                model.watches.push(outcome.id);
            },
        },
        {
            name: "watch-met",
            weight: 1,
            run: async (id) => {
                // Met on its first check and reported anyway: it fires at once, and nothing stays armed.
                check.exitCode = 0;
                const outcome = await armWatcher(watchSpec(id), { reportIfMet: true });
                check.exitCode = 1;
                expect(outcome.kind).toBe(modelOf(id).watches.length >= MAX_PER_CONVERSATION ? "refused" : "reported");
            },
        },
        {
            name: "watch-stop",
            weight: 1,
            run: async (id) => {
                const model = modelOf(id);
                const watchId = draw(model.watches);
                model.watches = model.watches.filter((armed) => armed !== watchId);
                expect(await cancelWatcher(id, watchId ?? "watch-none")).toBe(watchId !== undefined);
            },
        },
        {
            name: "run",
            weight: 2,
            run: async (id) => {
                const model = modelOf(id);
                const byPerson = random() < 0.5;
                const run = daemon.turns.run({ conversationId: id, prompt: "go", byPerson });
                // One run per conversation: refused while one is live, and a finished one is replaced; none at all on an
                // archived conversation nobody sent it to.
                const expected = model.archived && !byPerson ? "archived" : model.run === "live" ? "busy" : "run";
                expect(typeof run === "string" ? run : "run", `a run over a ${String(model.run)} one`).toBe(expected);
                if (typeof run === "string") {
                    return;
                }
                model.run = "live";
                await until(() => gates.has(id), `run ${id} parks`);
            },
        },
        { name: "run-end", weight: 2, run: async (id) => (modelOf(id).run === "live" ? endRun(id) : undefined) },
        {
            name: "dispose",
            weight: 1,
            run: async (id) => {
                const model = modelOf(id);
                // A discard refuses a conversation still running, by its card or by its run.
                if (model.running || model.run === "live" || leases.some((lease) => lease.id === id) || rewinds.some((rewind) => rewind.id === id)) {
                    return;
                }
                const held = raised.filter((card) => card.holder === id);
                await fleet.conversations.dispose([id]);
                models.set(id, { ...fresh(), standing: model.standing });
                journal.delete(id);
                // Its cards settle as their turn dying would.
                for (const card of held) {
                    raised.splice(raised.indexOf(card), 1);
                    await expectAborted(card);
                }
                const orphans = children.filter((child) => child.parent === id);
                for (const child of orphans) {
                    child.forgotten = true;
                    child.seated = false;
                }
                expectGone(fleet, id);
                // Children still running end after it is gone, and must bring nothing of it back.
                for (const child of orphans.filter((candidate) => candidate.running)) {
                    await endChild(child);
                }
                expectGone(fleet, id);
            },
        },
        {
            name: "dispose-child",
            weight: 1,
            run: async () => {
                // A settled one only, as a discard refuses a conversation still running.
                const child = draw(children.filter((candidate) => !candidate.running));
                if (child === undefined) {
                    return;
                }
                await fleet.conversations.dispose([child.id]);
                children.splice(children.indexOf(child), 1);
                expectGone(fleet, child.id);
            },
        },
        {
            name: "restart",
            weight: 1,
            run: async () => {
                if (leases.length === 0 && rewinds.length === 0) {
                    await restart();
                }
            },
        },
    ];
    const total = actions.reduce((sum, action) => sum + action.weight, 0);
    const choose = (): (typeof actions)[number] => {
        let roll = random() * total;
        for (const action of actions) {
            roll -= action.weight;
            if (roll < 0) {
                return action;
            }
        }
        return actions[0] as (typeof actions)[number];
    };

    let checked = 0;
    try {
        for (let step = 0; step < steps; step += 1) {
            const action = choose();
            const id = pick(IDS);
            log.push(`${action.name}(${id})`);
            await action.run(id);
            await drained();
            const where = `seed ${seed}, step ${step}: ${log.slice(-6).join(" ")}`;
            for (const each of IDS) {
                checkInvariants(fleet, each, modelOf(each), where);
            }
            checkHeldAcross(fleet, daemon.cards, { raised, children, runs: IDS.filter((each) => modelOf(each).run === "live") }, where);
            checked += 1;
        }
    } finally {
        for (const lease of [...leases, ...rewinds]) {
            lease.release();
            await lease.done;
        }
        await quiesce();
        stopWatchers();
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    return checked;
};

const checkInvariants = (fleet: Fleet, id: Id, model: Model, where: string): void => {
    const state = fleet.conversations.state(id);
    expect(fleet.conversations.running(id), where).toBe(model.running);
    // A card parks only on a live turn; none shows on a resting one.
    if (!model.running) {
        expect(state?.phase.kind === "running" ? state.phase.parked : [], where).toEqual([]);
    }
    // A hold is dispatched at most once, and the stop ladder never climbs past its rungs.
    expect(model.firedThisHold, where).toBeLessThanOrEqual(1);
    expect(state?.resume.stopTries ?? 0, where).toBeLessThanOrEqual(RETRY_LADDER_TRIES);
    checkCard(fleet, id, model, where);
    checkHeld(fleet, id, model, where);
};

// The card the registry projects, against what the model says it must show.
const checkCard = (fleet: Fleet, id: Id, model: Model, where: string): void => {
    const summary = fleet.agents.get(id);
    if (!model.exists) {
        expect(summary, where).toBeUndefined();
        return;
    }
    expect(summary?.status, where).toBe(expectedStatus(model));
    expect(summary?.attention, where).toMatchObject({
        plan: [...model.parked.values()].includes("plan"),
        question: [...model.parked.values()].includes("question"),
        permission: [...model.parked.values()].includes("permission"),
    });
    // Exactly one settle per run: the entry counts runs, never a settle that ended none.
    expect(fleet.agents.entry(id)?.totals.turns ?? 0, where).toBe(model.turns);
    expect(summary?.archivedAt !== undefined, where).toBe(model.archived);
};

// What the conversation holds, through the doors that file it and on the card its actor keeps.
const checkHeld = (fleet: Fleet, id: Id, model: Model, where: string): void => {
    const state = fleet.conversations.state(id);
    const running = model.jobs.filter((job) => !job.finished).map((job) => job.job.id);
    expect(supervisorFor(fleet.conversations, id), where).toBe(model.supervisor);
    expect(runOf(fleet, id), where).toBe(model.run);
    expect(
        runningJobsOf(fleet.conversations, id).map((job) => job.id),
        where,
    ).toEqual(running);
    // Running first, then how the recent ones ended.
    expect(
        (state?.jobs ?? []).map((job) => job.id),
        where,
    ).toEqual([...running, ...model.endings]);
    expect(
        listWatchers(id)
            .map((watch) => watch.id)
            .toSorted(),
        where,
    ).toEqual(model.watches.toSorted());
    expect((state?.watches ?? []).map((watch) => watch.id).toSorted(), where).toEqual(model.watches.toSorted());
};

// What the walk expects of the fleet as a whole: the cards it raised, the children it spawned, and which of its own
// conversations have a run live.
interface Across {
    readonly raised: readonly Card[];
    readonly children: readonly Child[];
    readonly runs: readonly Id[];
}

// What no one conversation's checks cover: cards, children and the fleet's live runs, which a door finds by their own
// ids alone.
const checkHeldAcross = (fleet: Fleet, cards: ParkedCards, { raised, children, runs }: Across, where: string): void => {
    const actors = fleet.conversations;
    for (const card of raised) {
        expect(cards.conversationOf(card.requestId), where).toBe(card.holder);
    }
    const ledger = childLedger(actors);
    for (const child of children) {
        expect(isSpawnedChild(actors, child.id), where).toBe(!child.forgotten);
        // A child's run is its own conversation's, so its parent's dispose leaves it.
        expect(runOf(fleet, child.id), where).toBe(child.held ? (child.running ? "live" : "finished") : undefined);
        if (!child.forgotten) {
            expect(ledger.find((kid) => kid.conversationId === child.id)?.running, where).toBe(child.running);
            expect(subagentEndingReported(actors, child.id), where).toBe(child.reported);
        }
    }
    const live = liveTurnConversations(actors).map((run) => run.conversationId);
    expect(live.toSorted(), where).toEqual([...runs, ...children.filter((child) => child.held && child.running).map((child) => child.id)].toSorted());
};

// Nothing of a disposed conversation survives: not its actor, its entry, its roster card, anything any holding filed by
// it or about it, or any index over them.
const expectGone = (fleet: Fleet, id: string): void => {
    expect(fleet.conversations.traces(id)).toEqual([]);
    expect(fleet.conversations.state(id)).toBeUndefined();
    expect(fleet.agents.entry(id)).toBeUndefined();
    expect(fleet.agents.get(id)).toBeUndefined();
    expect(fleet.agents.ids()).not.toContain(id);
    expect(fleet.conversations.turnActive(id)).toBe(false);
    expect(fleet.conversations.landing(id)).toBe(false);
    expect(fleet.conversations.stranded().map((stranded) => stranded.conversationId)).not.toContain(id);
    expect(fleet.conversations.liveSessionIds()).not.toContain(`s-${id}`);
    expect(turnRunOf(fleet.conversations, id)).toBeUndefined();
    expect(supervisorFor(fleet.conversations, id)).toBeUndefined();
    expect(isSpawnedChild(fleet.conversations, id)).toBe(false);
    expect(runningJobsOf(fleet.conversations, id)).toEqual([]);
    expect(listWatchers(id)).toEqual([]);
    expect(childLedger(fleet.conversations).filter((kid) => kid.parent === id || kid.conversationId === id)).toEqual([]);
    expect(listSubagentSessions(fleet.conversations).filter((session) => session.conversationId === id || session.id === id)).toEqual([]);
};

describe("the conversation actors, walked at random against a model of their rules", () => {
    // A hang bound, not a measure: each walk is a few hundred events through real writes and microtask drains.
    test.each([1, 2, 3, 4, 5, 6, 7, 8])(
        "seed %d keeps every invariant for 300 steps",
        async (seed) => expect(await walk(seed, 300)).toBe(300),
        60_000,
    );
});

describe("disposal", () => {
    test("of a conversation that held every kind of record leaves nothing behind in any index", async () => {
        const db = openConversationsDb(IN_MEMORY);
        const fleet = createFleet(fleetStoreOver(db), standingsOf(new Map()), PRESENCES);
        await fleet.agents.init();
        const input = { prompt: "go", conversationId: "c1" };
        await fleet.conversations.send("c1", { kind: "begin", turn: { conversationId: "c1", isolated: true, prompt: "go", profile: {}, byPerson: true } }, 1).settled;
        fleet.conversations.send("c1", { kind: "frame", frame: { kind: "session", sessionId: "s-c1" } }, 2);
        const unregister = fleet.conversations.registerTurn("c1", { abort: () => {} });
        await fleet.conversations.send("c1", { kind: "settle" }, 3).settled;
        unregister();
        fleet.conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", ran: true } }, 4);
        fleet.conversations.send("c1", { kind: "grant-restored", tool: "Bash", always: false }, 5);
        fleet.conversations.send("c1", { kind: "steer-reserved" }, 6);
        expect(fleet.conversations.stranded().map((stranded) => stranded.conversationId)).toEqual(["c1"]);

        await fleet.conversations.dispose(["c1"]);

        expectGone(fleet, "c1");
        expect(db.rowsOf("c1")).toEqual({});
    });

    test("forgets only what it names, and keeps the others' order", async () => {
        const fleet = createFleet(memoryStore(), standingsOf(new Map()), PRESENCES);
        const outage = (id: string) => ({ input: { prompt: "go", conversationId: id }, reason: "outage" as const, ran: false });
        fleet.conversations.send("c1", { kind: "turn-held", held: outage("c1") }, 1);
        fleet.conversations.send("c2", { kind: "turn-held", held: outage("c2") }, 2);
        fleet.conversations.send("c3", { kind: "turn-held", held: outage("c3") }, 3);
        // A re-record keeps its place, the order a pass meets them in.
        fleet.conversations.send("c1", { kind: "turn-held", held: outage("c1") }, 4);

        await fleet.conversations.dispose(["c2"]);

        expect(fleet.conversations.stranded().map((stranded) => stranded.conversationId)).toEqual(["c1", "c3"]);
    });
});
