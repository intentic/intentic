import type { Trigger, WorkspaceEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { fireAutomation, firedBy, type WakeFn } from "./scheduler.js";

// Chores: automations triggered by a WorkspaceEvent the daemon both emits and consumes, no webhook or token involved.
// Serial on two levels: a per-chore FIFO queue coalesces by agent (oldest dropped past QUEUE_MAX), and one shared chain
// keeps every chore's turn from overlapping another's. Never fires on the `turn.settled` its own turn raises.

// Distinct agents that may wait on one chore; a deeper backlog means narrowing the trigger, not queuing harder.
const QUEUE_MAX = 4;

// Workspace-wide chain keeping every chore's turn from overlapping another's, on top of each one's own queue.
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

// Per-automation queues, a module singleton like the scheduler's inFlight, every emitter shares one.
const queues = new Map<string, Queue>();

const matches = (id: string, trigger: Extract<Trigger, { kind: "workspace" }>, event: WorkspaceEvent): boolean =>
    trigger.event === event.event &&
    (trigger.repo === undefined || event.repos.some(({ repo }) => repo === trigger.repo)) &&
    !firedBy(id, event.agentId);

// Drains one automation's queue, re-reading the manifest per event so an edit, disable or delete while the backlog
// waits is honored.
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
        // Nothing awaits between the empty-queue check and here, so no event can land in a just-stopped queue.
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
            services.logger.warn({ automation: id, agent: dropped?.agentId }, "chore backlog full, dropped the oldest waiting event");
        }
    }
    void pump(services, id, wake);
};

// Routes one workspace event to every matching enabled chore, returning the matched ids. `wake` is injected rather than
// imported, since importing streamAgent here would close a cycle through agent.routes.
export const dispatchWorkspaceEvent = async (services: Services, event: WorkspaceEvent, wake: WakeFn): Promise<string[]> => {
    const matched: string[] = [];
    for (const automation of await services.automations.list()) {
        if (!automation.enabled || automation.trigger.kind !== "workspace" || !matches(automation.id, automation.trigger, event)) {
            continue;
        }
        matched.push(automation.id);
        enqueue(services, automation.id, event, wake);
    }
    // Only for deps.broken: turn-borne events are routinely unclaimed; logging each trains the eye to skip.
    if (event.event === "deps.broken" && matched.length === 0) {
        void services.activity
            .append({
                direction: "system",
                type: "deps.fix_unarmed",
                content: `Checks broke for ${event.deps?.project === "" ? "the workspace root" : (event.deps?.project ?? "a project")} and no automation is enabled for it, the "Fix what a dependency change broke" chore on the Automations page can handle this for you.`,
                outcome: "error",
                conversationId: event.agentId,
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    }
    return matched;
};

// Fire-and-forget wrapper for emit sites inside a turn's or route's own lifecycle: a dispatch failure is logged, never
// propagated, since the turn must settle regardless.
export const emitWorkspaceEvent = (services: Services, event: WorkspaceEvent, wake: WakeFn): void => {
    void dispatchWorkspaceEvent(services, event, wake).catch((error: unknown) =>
        services.logger.warn({ err: error, event: event.event }, "workspace event dispatch failed"),
    );
};
