import { randomUUID } from "node:crypto";
import { serialLock } from "@intentic/base/async";
import type { Trigger, WorkspaceEvent } from "@intentic/sandbox-contract/schemas/automations";
import type { Services } from "../composition.js";
import { firedBy } from "./fire/fire-sessions.js";
import { fireAutomation } from "./scheduler.js";
import { perDaemon } from "./durable/daemon-memory.js";
import { addWorkspaceEvent, consumeInbox, dropWorkspaceBacklog, type WorkspaceEntry } from "./durable/inbox-store.js";

// Chores: automations triggered by a WorkspaceEvent the daemon both emits and consumes, no webhook or token involved.
// Serial on two levels: a per-chore FIFO queue coalesces by agent (oldest dropped past QUEUE_MAX), and one shared chain
// keeps every chore's turn from overlapping another's. Never fires on the `turn.settled` its own turn raises. Subscribed
// to the daemon's domain events in composition.ts, never called by whatever announced one.

// Distinct agents that may wait on one chore; a deeper backlog means narrowing the trigger, not queuing harder.
const QUEUE_MAX = 4;

// Workspace-wide chain keeping every chore's turn from overlapping another's, on top of each one's own queue.
const seriallyOf = perDaemon(() => serialLock());

interface Queue {
    readonly waiting: { id: string; event: WorkspaceEvent }[];
    running: boolean;
}

// Per-automation queues, one set per daemon (durable/daemon-memory.ts) like the scheduler's lanes; every emitter shares it.
const queuesOf = perDaemon(() => new Map<string, Queue>());

const matches = (id: string, trigger: Extract<Trigger, { kind: "workspace" }>, event: WorkspaceEvent): boolean =>
    trigger.event === event.event &&
    (trigger.repo === undefined || event.repos.some(({ repo }) => repo === trigger.repo)) &&
    !firedBy(id, event.agentId);

// Drains one automation's queue, re-reading the manifest per event so an edit, disable or delete while the backlog
// waits is honored.
const pump = async (services: Services, id: string): Promise<void> => {
    const queues = queuesOf.of(services);
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
                // Switched off or gone: its backlog goes with it, here and in the inbox a restart would replay.
                queue.waiting.length = 0;
                await dropWorkspaceBacklog(services, id);
                return;
            }
            // Queued, not dropped, behind another run of the chore (a press of Run now, a restart's replay), so the event is
            // owed its run; its inbox row is let go once the fire is journalled, which a restart replays instead.
            const options = { payload: JSON.stringify(next.event), overlap: "queue", inboxIds: [next.id], accepted: () => consumeInbox(services, [next.id]) } as const;
            await seriallyOf.of(services)(() => fireAutomation(services, fresh, options)).catch((error: unknown) =>
                services.logger.error({ err: error, automation: id, agent: next.event.agentId }, "chore run failed"),
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

// Into the chore's queue and its durable inbox (durable/inbox-store.ts), coalesced by agent and capped as before: an event the
// queue replaces or drops leaves the inbox with it.
const enqueue = async (services: Services, id: string, event: WorkspaceEvent): Promise<void> => {
    const queues = queuesOf.of(services);
    const queue = queues.get(id) ?? { waiting: [], running: false };
    queues.set(id, queue);
    const item = { id: randomUUID(), event };
    const at = queue.waiting.findIndex((waiting) => waiting.event.agentId === event.agentId);
    const removed: string[] = [];
    if (at !== -1) {
        removed.push(queue.waiting[at]!.id);
        queue.waiting[at] = item;
    } else {
        queue.waiting.push(item);
        if (queue.waiting.length > QUEUE_MAX) {
            const dropped = queue.waiting.shift();
            if (dropped !== undefined) {
                removed.push(dropped.id);
                services.logger.warn({ automation: id, agent: dropped.event.agentId }, "chore backlog full, dropped the oldest waiting event");
            }
        }
    }
    await addWorkspaceEvent(services, { ...item, automationId: id }, removed);
    void pump(services, id);
};

// At boot (fire-resume.ts), after the journalled fires: what still waited for each chore, back in its queue in order.
export const resumeWorkspaceInbox = async (services: Services, rows: readonly WorkspaceEntry[]): Promise<void> => {
    const queues = queuesOf.of(services);
    const ids = new Set<string>();
    for (const entry of rows) {
        const queue = queues.get(entry.automationId) ?? { waiting: [], running: false };
        queue.waiting.push({ id: entry.id, event: entry.event });
        queues.set(entry.automationId, queue);
        ids.add(entry.automationId);
    }
    for (const id of ids) {
        void pump(services, id);
    }
};

// Routes one workspace event to every matching enabled chore, returning the matched ids.
export const dispatchWorkspaceEvent = async (services: Services, event: WorkspaceEvent): Promise<string[]> => {
    const matched: string[] = [];
    for (const automation of await services.automations.list()) {
        if (!automation.enabled || automation.trigger.kind !== "workspace" || !matches(automation.id, automation.trigger, event)) {
            continue;
        }
        matched.push(automation.id);
        await enqueue(services, automation.id, event);
    }
    return matched;
};
