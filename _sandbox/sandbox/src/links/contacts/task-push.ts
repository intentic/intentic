import { keyedLock } from "@intentic/base/async";
import type { LinkTaskState, LinkTaskStatus } from "@intentic/sandbox-contract/schemas/links";
import type { Logger } from "pino";
import type { StoredLinkTask } from "../inbound-links.js";
import type { PersonTasksStore } from "../person-tasks-store.js";
import type { ContactRow, ContactsStore } from "../../s2s/contacts/contacts-store.js";
import type { S2sOutbox } from "../../s2s/messages/outbox.js";
import type { ContactTasksStore } from "./contact-tasks-store.js";
import { CONTACT_ROUTE_PREFIX } from "./taking.js";

/* A CONTACT'S TASK STATUS, PUSHED (2026-11-27, docs/architecture/messages.md "Tasks"): where a link's asker long-polled
 * (`GET /link/conversations/{id}?after=&wait=`), a contact is sent `task.update` (the `LinkTaskStatus`) whenever its
 * task's version moves, so neither side holds a request open and a hosted asker sleeps through a long task.
 * - Heard off the nudge a held link read waits on (links/link-task-status-wait.ts): every stored move, a run parking on a
 *   card, an answer unparking it. An owner's card answered here unparks a run with no nudge; the sweep every five seconds
 *   over live tasks catches it.
 * - At most one update every five seconds per task, the latest once the five seconds are up, and at once when it settles.
 * - One at a time per task: the next goes once the last has landed (or was let go), and is then whatever the status is.
 *   A version is not an order (it falls back when a run unparks), so the asking side takes any version it has not just
 *   seen as the truth, which holds only while two updates of one task are never in the outbox together.
 * - What was pushed is kept in memory. At boot each update still waiting in the outbox counts as the one in flight, and
 *   every live task's status is pushed again, and every one settled within the last hour, so an update a stop cut off
 *   between the move and the outbox still goes; the asking side takes a version it has as nothing. The outbox carries
 *   each update from there, through a sleeping asker, for a week. */

const PUSH_EVERY_MS = 5_000;
const SWEEP_EVERY_MS = 5_000;
// How far back a boot pushes settled tasks again.
const BOOT_SETTLED_MS = 60 * 60 * 1000;
const SETTLED: ReadonlySet<LinkTaskState> = new Set(["finished", "failed", "declined", "stopped"]);
const LIVE: ReadonlySet<StoredLinkTask["state"]> = new Set(["held", "running"]);

export interface TaskPushDeps {
    readonly contacts: Pick<ContactsStore, "get">;
    readonly book: Pick<ContactTasksStore, "linkOf" | "list">;
    readonly personTasks: Pick<PersonTasksStore, "ownerOf" | "list">;
    // Where a task stands, as the contact reads it (taking.ts contactStatusOf).
    readonly status: (row: ContactRow, task: StoredLinkTask) => LinkTaskStatus;
    readonly outbox: Pick<S2sOutbox, "enqueue" | "list" | "onSettled">;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
}

export interface TaskPusher {
    // A task's status may have moved: pushed now, or within five seconds, coalesced to the latest. Never rejects.
    readonly nudge: (conversationId: string) => void;
    // As `nudge`, awaited: a status never pushed (a task filed waiting for the owner moved nothing a nudge hears) goes now.
    readonly push: (conversationId: string) => Promise<void>;
    // Every live task looked at again; `boot` pushes each, and each settled in the last hour, whatever was pushed.
    readonly sweep: (boot?: boolean) => Promise<void>;
    // Sweeps every five seconds until stopped; answers the stop.
    readonly start: () => () => void;
}

interface Pushed {
    version: number | undefined;
    at: number;
    settled: boolean;
    timer: ReturnType<typeof setTimeout> | undefined;
    // The update the outbox still holds for this task, and whether the status moved while it did.
    flight: string | undefined;
    again: boolean;
}

// The contact that opened a conversation here, and the task, from either book; undefined for any other conversation.
const ownedBy = async (deps: TaskPushDeps, conversationId: string): Promise<{ readonly row: ContactRow; readonly task: StoredLinkTask } | undefined> => {
    const own = await deps.book.linkOf(conversationId);
    const routed = own === undefined ? await deps.personTasks.ownerOf(conversationId) : undefined;
    const contactId = own?.linkId ?? (routed?.key.from.startsWith(CONTACT_ROUTE_PREFIX) === true ? routed.key.from.slice(CONTACT_ROUTE_PREFIX.length) : undefined);
    const task = own?.task ?? routed?.task;
    const row = contactId === undefined ? undefined : await deps.contacts.get(contactId);
    return row === undefined || task === undefined || row.state !== "accepted" ? undefined : { row, task };
};

// Every task a contact opened here, from both books.
const contactTasks = async (deps: TaskPushDeps): Promise<readonly StoredLinkTask[]> => [
    ...(await deps.book.list()).flatMap((entry) => entry.tasks),
    ...(await deps.personTasks.list()).filter((entry) => entry.key.from.startsWith(CONTACT_ROUTE_PREFIX)).flatMap((entry) => entry.tasks),
];

// What the pusher keeps between nudges: each task's last push, each update the outbox holds, and one look at a time per task.
interface PushState {
    readonly pushed: Map<string, Pushed>;
    readonly flights: Map<string, string>;
    readonly serialize: ReturnType<typeof keyedLock<string>>;
}

const heldFor = (state: PushState, conversationId: string): Pushed => {
    const held = state.pushed.get(conversationId) ?? { version: undefined, at: 0, settled: false, timer: undefined, flight: undefined, again: false };
    state.pushed.set(conversationId, held);
    return held;
};

const warnFor = (deps: TaskPushDeps, conversationId: string) => (error: Error) =>
    deps.logger.warn({ err: error, conversation: conversationId }, "s2s task: a status was not pushed");

const send = async (deps: TaskPushDeps, state: PushState, found: { readonly row: ContactRow; readonly task: StoredLinkTask }, status: LinkTaskStatus, held: Pushed): Promise<void> => {
    const { row, task } = found;
    clearTimeout(held.timer);
    held.timer = undefined;
    const queued = await deps.outbox.enqueue({ contact: row, payload: { kind: "task.update", task: task.requestId, status } });
    if ("refused" in queued) {
        deps.logger.warn({ contact: row.id, conversation: task.conversationId, why: queued.refused }, "s2s task: a status could not be queued");
        return;
    }
    held.version = status.version;
    held.at = deps.now();
    held.settled = SETTLED.has(status.state);
    held.flight = queued.id;
    state.flights.set(queued.id, task.conversationId);
};

// One look at a task: its status pushed now, deferred to the end of its five seconds or past the update in flight, or not
// at all when that very version already went (unless `force`).
const lookerFor = (deps: TaskPushDeps, state: PushState) => {
    const look = async (conversationId: string, force: boolean): Promise<void> =>
        state.serialize(conversationId, async () => {
            const found = await ownedBy(deps, conversationId);
            if (found === undefined) {
                return;
            }
            const held = heldFor(state, conversationId);
            // One in the outbox at a time: the latest goes once it lands.
            if (held.flight !== undefined) {
                held.again = true;
                return;
            }
            const status = deps.status(found.row, found.task);
            if (!force && held.version === status.version) {
                return;
            }
            const wait = held.at + PUSH_EVERY_MS - deps.now();
            if (force || wait <= 0 || SETTLED.has(status.state)) {
                await send(deps, state, found, status, held);
                return;
            }
            // Within five seconds of the last: once they are up, whatever the status is then.
            held.timer ??= setTimeout(() => {
                held.timer = undefined;
                void look(conversationId, false).catch(warnFor(deps, conversationId));
            }, wait);
            held.timer.unref();
        });
    return look;
};

// At boot: every update the outbox still holds is the one in flight for its task.
const adoptFlights = async (deps: TaskPushDeps, state: PushState): Promise<void> => {
    for (const entry of await deps.outbox.list()) {
        if (entry.state === "waiting" && entry.payload.kind === "task.update") {
            const conversationId = entry.payload.status.conversationId;
            state.flights.set(entry.id, conversationId);
            Object.assign(heldFor(state, conversationId), { flight: entry.id, again: true });
        }
    }
};

const sweeperFor =
    (deps: TaskPushDeps, state: PushState, look: (conversationId: string, force: boolean) => Promise<void>) =>
    async (boot = false): Promise<void> => {
        if (boot) {
            await adoptFlights(deps, state);
        }
        const since = deps.now() - BOOT_SETTLED_MS;
        for (const task of await contactTasks(deps)) {
            if (LIVE.has(task.state) || (boot && task.updatedAt >= since)) {
                await look(task.conversationId, boot);
            }
        }
        // A settled task's mark is kept an hour past its last push, against a late nudge, then forgotten.
        for (const [conversationId, held] of state.pushed) {
            if (held.settled && held.timer === undefined && held.flight === undefined && held.at < since) {
                state.pushed.delete(conversationId);
            }
        }
    };

export const createTaskPusher = (deps: TaskPushDeps): TaskPusher => {
    const state: PushState = { pushed: new Map(), flights: new Map(), serialize: keyedLock<string>() };
    const look = lookerFor(deps, state);
    const sweep = sweeperFor(deps, state, look);
    // An update landed, or was let go: the next, if the status moved meanwhile.
    deps.outbox.onSettled(async (entry, settled) => {
        const conversationId = state.flights.get(entry.id);
        if (conversationId === undefined || settled.state === "queued") {
            return;
        }
        state.flights.delete(entry.id);
        const held = heldFor(state, conversationId);
        held.flight = undefined;
        if (held.again) {
            held.again = false;
            await look(conversationId, false);
        }
    });
    return {
        nudge: (conversationId) => {
            void look(conversationId, false).catch(warnFor(deps, conversationId));
        },
        push: (conversationId) => look(conversationId, false),
        sweep,
        start: () => {
            const timer = setInterval(() => {
                void sweep().catch((error: Error) => deps.logger.warn({ err: error }, "s2s task: the status sweep failed"));
            }, SWEEP_EVERY_MS);
            timer.unref();
            return () => {
                clearInterval(timer);
                for (const held of state.pushed.values()) {
                    clearTimeout(held.timer);
                }
            };
        },
    };
};
