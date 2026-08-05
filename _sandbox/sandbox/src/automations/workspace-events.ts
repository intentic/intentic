import type { Trigger, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { fireAutomation, type WakeFn } from "./scheduler.js";

// Workspace-triggered wakes — the CHORES. The daemon emits a WorkspaceEvent as the fleet works (an isolated
// turn settled, an agent's work landed) and every enabled automation naming that event wakes with the event as
// its payload. Producer and consumer are both the daemon, so unlike an `event` automation there is no webhook,
// no token, and nothing outside the sandbox that can fire one.
//
// SERIAL, not fan-out, on two levels.
//
// Per chore, a FIFO queue: fireAutomation's own overlap guard DROPS concurrent fires, which is exactly wrong
// here — five agents settling in a burst would silently lose four reviews. Waiting events COALESCE by agent
// (a newer event for an agent already queued REPLACES it, because reviewing the same agent twice in a row pays
// twice to be told the later answer), and past QUEUE_MAX distinct agents the oldest is dropped and LOGGED: a
// chore this far behind will not catch up, and a silent cap would read as "everything got reviewed".
//
// Across chores, one shared chain: a chore's turn runs on /work (only fleet agents get their own worktree), so
// two at once would be two agents editing and testing the same tree — the constraint webchat's queue exists
// for. Background work has no reason to race the user for the tree or the CPU, so it waits its turn.

// Distinct agents that may wait on one chore. Small on purpose: each entry is a whole agent turn's worth of
// spend, and a backlog deeper than this is a signal to narrow the chore's trigger, not to queue harder.
const QUEUE_MAX = 4;

// The workspace-wide chore turn chain. Per-automation queues keep each chore's backlog fair and coalescible;
// this is what keeps their TURNS from overlapping each other.
let turnChain: Promise<unknown> = Promise.resolve();
const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = turnChain.then(task, task);
    turnChain = next.catch(() => undefined);
    return next;
};

interface Queue {
    readonly waiting: WorkspaceEvent[];
    running: boolean;
}

// Per-automation queues, a module singleton like the scheduler's inFlight — every emitter shares one.
const queues = new Map<string, Queue>();

const matches = (trigger: Extract<Trigger, { kind: "workspace" }>, event: WorkspaceEvent): boolean =>
    trigger.event === event.event && (trigger.repo === undefined || event.repos.some(({ repo }) => repo === trigger.repo));

// Drain one automation's queue. Re-reads the manifest per event so an edit, a disable or a delete while the
// backlog waits is honored — the same freshness rule listeners' batcher follows.
const pump = async (services: Services, id: string, wake: WakeFn): Promise<void> => {
    const queue = queues.get(id);
    if (queue === undefined || queue.running) {
        return;
    }
    queue.running = true;
    try {
        for (;;) {
            const next = queue.waiting.shift();
            if (next === undefined) {
                return;
            }
            const fresh = await services.automations.get(id);
            if (fresh === undefined || !fresh.enabled || fresh.trigger.kind !== "workspace") {
                return;
            }
            await serially(() => fireAutomation(services, fresh, wake, { payload: JSON.stringify(next) })).catch((error: unknown) =>
                services.logger.error({ err: error, automation: id, agent: next.agentId }, "chore run failed"),
            );
        }
    } finally {
        // Nothing awaits between the empty-queue check and here, so no event can arrive into a queue that has
        // just stopped pumping.
        queue.running = false;
        if (queue.waiting.length === 0) {
            queues.delete(id);
        }
    }
};

const enqueue = (services: Services, id: string, event: WorkspaceEvent, wake: WakeFn): void => {
    const queue = queues.get(id) ?? { waiting: [], running: false };
    queues.set(id, queue);
    const at = queue.waiting.findIndex((waiting) => waiting.agentId === event.agentId);
    if (at !== -1) {
        queue.waiting[at] = event;
    } else {
        queue.waiting.push(event);
        if (queue.waiting.length > QUEUE_MAX) {
            const dropped = queue.waiting.shift();
            services.logger.warn({ automation: id, agent: dropped?.agentId }, "chore backlog full — dropped the oldest waiting event");
        }
    }
    void pump(services, id, wake);
};

// Route one workspace event to every matching enabled chore. Returns the ids that matched (tests assert on it;
// callers fire and forget). `wake` is INJECTED rather than imported: every emit site lives downstream of
// agent.routes, and importing streamAgent here would close a cycle — the same reason turn-runs takes its TurnFn.
export const dispatchWorkspaceEvent = async (services: Services, event: WorkspaceEvent, wake: WakeFn): Promise<string[]> => {
    const matched: string[] = [];
    for (const automation of await services.automations.list()) {
        if (!automation.enabled || automation.trigger.kind !== "workspace" || !matches(automation.trigger, event)) {
            continue;
        }
        matched.push(automation.id);
        enqueue(services, automation.id, event, wake);
    }
    /* `deps.broken` exists to offer a fix, so a breakage nothing is armed for is said rather than swallowed —
     * informed, never silently unprotected. Only this event: the turn-borne kinds fire on every turn and are
     * routinely unclaimed, and an entry per unclaimed one would be the feed teaching the eye to skip it. */
    if (event.event === "deps.broken" && matched.length === 0) {
        void services.activity
            .append({
                direction: "system",
                type: "deps.fix_unarmed",
                content: `Checks broke for ${event.deps?.project === "" ? "the workspace root" : (event.deps?.project ?? "a project")} and no automation is enabled for it — the "Fix what a dependency change broke" chore on the Automations page can handle this for you.`,
                outcome: "error",
                conversationId: event.agentId,
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    }
    return matched;
};

// Fire-and-forget wrapper for the emit sites, which all sit inside a turn's or a route's own lifecycle: a turn
// must settle whether or not a chore is listening, so a dispatch failure is logged, never propagated.
export const emitWorkspaceEvent = (services: Services, event: WorkspaceEvent, wake: WakeFn): void => {
    void dispatchWorkspaceEvent(services, event, wake).catch((error: unknown) =>
        services.logger.warn({ err: error, event: event.event }, "workspace event dispatch failed"),
    );
};
