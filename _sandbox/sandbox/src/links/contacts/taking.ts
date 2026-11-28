import { type LinkTask, type LinkTaskStatus, LinkTermsSchema } from "@intentic/sandbox-contract/schemas/links";
import { S2S_MAX_HOPS, type S2sPayloadOf } from "@intentic/sandbox-contract/schemas/s2s";
import type { Caller } from "../../auth/auth.js";
import type { LinkTaskBook, StoredLinkTask, TaskOrigin } from "../inbound-links.js";
import { answerTask, askTask, decideTask, heldStatus, type LinkRefusal, type LinkTaskDeps, messageTask, statusOf, stopTask } from "../link-tasks.js";
import { askPersonTask, messagePersonTask, type PersonTaskDeps, personStatusOf, stopPersonTask } from "../person-tasks.js";
import type { PersonRouteKey } from "../person-tasks-store.js";
import { opt } from "../../opt.js";
import type { ContactRow, ContactsStore } from "../../s2s/contacts/contacts-store.js";
import type { S2sHearing } from "../../s2s/heard.js";
import type { S2sKindOutcome, S2sKinds, S2sReceived } from "../../s2s/messages/kinds.js";
import type { ContactTasksStore } from "./contact-tasks-store.js";

/* THE TAKING SIDE OF A CONTACT'S TASK (2026-11-27, docs/architecture/messages.md "Tasks"): `task.request`, `task.message`,
 * `task.answer` and `task.stop`, each admitted already (the contact, its key, its `task` grant, a person-scoped contact's
 * person above the task floor, the hops, the minute), filed and moved exactly as the link doors did, by the same code:
 * - a sandbox-scoped contact's task is a link task (links/link-tasks.ts) whose origin is the contact: the role, approval
 *   and hourly turns its grant carries, its own book (contact-tasks-store.ts), its allowance under `contact:<id>`;
 * - a person-scoped contact's task is a person's routed task (links/person-tasks.ts), keyed `contact:<id>` and the person:
 *   that person's conversation, their floor, 20 starts an hour per (contact, person).
 * What comes back is not an answer but pushed `task.update` messages (task-push.ts); a refusal is answered in words with
 * a code the sender's outbox does not retry (`task`, or `hops`), so the asking agent hears why at once. */

/** The `from` a person-scoped contact's tasks are keyed under in the person tasks' book; a route pass names a sandbox id. */
export const CONTACT_ROUTE_PREFIX = "contact:";

/** A sandbox-scoped contact as a task origin: its id, its name, its address, and its task grant as a link's terms. */
const contactOrigin = (row: ContactRow): TaskOrigin | undefined => {
    const grant = row.grants.task;
    if (grant === undefined || row.scope.kind !== "sandbox") {
        return undefined;
    }
    return { id: row.id, label: row.name ?? row.document.name, contact: { address: row.address }, terms: LinkTermsSchema.parse({ ...grant, tasks: true }) };
};

/** A person-scoped contact's tasks as the person tasks' book keys them. */
const contactRouteKey = (row: ContactRow & { readonly scope: { readonly kind: "person"; readonly person: string } }): PersonRouteKey => ({
    from: `${CONTACT_ROUTE_PREFIX}${row.id}`,
    fromName: row.name ?? row.document.name,
    person: row.scope.person,
});

const personScoped = (row: ContactRow): row is ContactRow & { readonly scope: { readonly kind: "person"; readonly person: string } } => row.scope.kind === "person";

/**
 * The contacts' task book as the link task code reads it. A task filed to run whose first turn was never said is started
 * at boot under its contact's grant as it is now; one whose contact is gone, or no longer granted tasks, fails instead,
 * said in words the asking side reads.
 */
export const contactTaskBook = (store: ContactTasksStore, contacts: Pick<ContactsStore, "get">, now: () => number = Date.now): LinkTaskBook => ({
    task: store.task,
    addTask: store.addTask,
    moveTask: store.moveTask,
    linkOf: store.linkOf,
    unstarted: async () => {
        const ready: { readonly link: TaskOrigin; readonly task: StoredLinkTask }[] = [];
        for (const { contact, task } of await store.unstarted()) {
            const row = await contacts.get(contact);
            const origin = row?.state === "accepted" ? contactOrigin(row) : undefined;
            if (origin === undefined) {
                const error = "It could not start here: this sandbox no longer takes tasks from yours.";
                await store.moveTask(contact, task.conversationId, { state: "failed", error, forgetTask: true }, now());
                continue;
            }
            ready.push({ link: origin, task });
        }
        return ready;
    },
});

export interface TakingDeps {
    // The link task code's deps, its book the contacts' (contactTaskBook).
    readonly link: LinkTaskDeps;
    // The person tasks' code, for a person-scoped contact.
    readonly person: PersonTaskDeps;
    readonly hear: S2sHearing;
    // Pushes a task's status unless that very version already went (task-push.ts): one filed waiting for the owner moved
    // nothing a nudge would hear.
    readonly push: (conversationId: string) => Promise<void>;
}

// A refusal as the inbox answers it: in words, with a code the sender's outbox ends on rather than retries for a week.
const refusedWith = (refusal: LinkRefusal, hops = false): S2sKindOutcome => ({
    refused: hops ? "hops" : refusal.refused === 400 ? "malformed" : "task",
    error: refusal.message,
});

const isRefusal = <T extends object>(value: T | LinkRefusal): value is LinkRefusal => "refused" in value;

// The person a person-scoped contact routes as, read off the roster now; admission already held them to the task floor.
const personOf = async (deps: TakingDeps, row: ContactRow & { readonly scope: { readonly person: string } }): Promise<Caller | LinkRefusal> =>
    (await deps.person.personOf(row.scope.person)) ?? { refused: 409, message: `${row.scope.person} is not a member of this sandbox any more.` };

// The asked task, its hops the more of what the payload and the envelope say: a sender cannot understate one.
const askedOf = (received: S2sReceived<"task.request">): LinkTask => {
    const { kind: _kind, ...task } = received.payload;
    return { ...task, hops: Math.max(task.hops, received.header.hops) };
};

// The task the contact opened under the request id the payload names, in its scope's book.
const taskOf = async (deps: Pick<TakingDeps, "link" | "person">, row: ContactRow, requestId: string): Promise<StoredLinkTask | undefined> =>
    personScoped(row) ? deps.person.tasks.task(contactRouteKey(row), { requestId }) : deps.link.links.task(row.id, { requestId });

const NO_SUCH_TASK: LinkRefusal = { refused: 404, message: "This sandbox holds no task by that id that your sandbox handed it." };

// A request filed: told to automations, and its status pushed unless it already went (one waiting for the owner moved nothing).
const filed = (deps: TakingDeps, row: ContactRow, received: S2sReceived<"task.request">, status: LinkTaskStatus): S2sKindOutcome => ({
    stored: true,
    after: async () => {
        await deps.push(status.conversationId);
        await deps.hear({
            event: "task.request",
            contact: row,
            envelope: received.header.id,
            task: received.payload.task,
            ...opt("title", received.payload.title),
            requestId: received.payload.requestId,
            conversationId: status.conversationId,
            at: received.receivedAt,
        });
    },
});

const request = async (deps: TakingDeps, row: ContactRow, received: S2sReceived<"task.request">): Promise<S2sKindOutcome> => {
    const asked = askedOf(received);
    // A repeat answers the task already taken whatever its hops; a new one past them is refused before anything is filed.
    const pastHops = asked.hops >= S2S_MAX_HOPS && (await taskOf(deps, row, asked.requestId)) === undefined;
    let status: LinkTaskStatus | LinkRefusal;
    if (personScoped(row)) {
        const person = await personOf(deps, row);
        status = isRefusal(person) ? person : await askPersonTask(deps.person, contactRouteKey(row), person, asked);
    } else {
        const origin = contactOrigin(row);
        status = origin === undefined ? { refused: 409, message: "This sandbox takes no tasks from yours." } : await askTask(deps.link, origin, asked);
    }
    if (isRefusal(status)) {
        return refusedWith(status, pastHops);
    }
    return filed(deps, row, received, status);
};

const message = async (deps: TakingDeps, row: ContactRow, payload: S2sPayloadOf<"task.message">): Promise<S2sKindOutcome> => {
    const task = await taskOf(deps, row, payload.task);
    if (task === undefined) {
        return refusedWith(NO_SUCH_TASK);
    }
    let sent: object | LinkRefusal;
    if (personScoped(row)) {
        const person = await personOf(deps, row);
        sent = isRefusal(person) ? person : await messagePersonTask(deps.person, contactRouteKey(row), person, task, payload.message);
    } else {
        const origin = contactOrigin(row);
        sent = origin === undefined ? NO_SUCH_TASK : await messageTask(deps.link, origin, task, payload.message);
    }
    return isRefusal(sent) ? refusedWith(sent) : { stored: true };
};

const answer = async (deps: TakingDeps, row: ContactRow, payload: S2sPayloadOf<"task.answer">): Promise<S2sKindOutcome> => {
    const task = await taskOf(deps, row, payload.task);
    if (task === undefined) {
        return refusedWith(NO_SUCH_TASK);
    }
    const refused = await answerTask(deps.link, task, payload.answer);
    return refused === undefined ? { stored: true } : refusedWith(refused);
};

const stop = async (deps: TakingDeps, row: ContactRow, payload: S2sPayloadOf<"task.stop">): Promise<S2sKindOutcome> => {
    const task = await taskOf(deps, row, payload.task);
    if (task === undefined) {
        return refusedWith(NO_SUCH_TASK);
    }
    const origin = contactOrigin(row);
    if (!personScoped(row) && origin === undefined) {
        return refusedWith(NO_SUCH_TASK);
    }
    const stopped = origin === undefined ? await stopPersonTask(deps.person, task) : await stopTask(deps.link, origin, task);
    // One already settled moves nothing: its status goes unless it already went, so the asking side still hears where it stands.
    return stopped.version === task.version ? { stored: true, after: async () => deps.push(task.conversationId) } : { stored: true };
};

const onlyContacts =
    <K extends "task.request" | "task.message" | "task.answer" | "task.stop">(act: (row: ContactRow, received: S2sReceived<K>) => Promise<S2sKindOutcome>) =>
    async (received: S2sReceived<K>): Promise<S2sKindOutcome> =>
        received.contact === undefined ? { refused: "not_contact", error: "only a contact hands this sandbox tasks" } : act(received.contact, received);

/** Registers the taking side's kinds with the inbox; answers their removal. */
export const registerTakingKinds = (kinds: Pick<S2sKinds, "register">, deps: TakingDeps): (() => void) => {
    const removals = [
        kinds.register("task.request", onlyContacts((row, received) => request(deps, row, received))),
        kinds.register("task.message", onlyContacts((row, received) => message(deps, row, received.payload))),
        kinds.register("task.answer", onlyContacts((row, received) => answer(deps, row, received.payload))),
        kinds.register("task.stop", onlyContacts((row, received) => stop(deps, row, received.payload))),
    ];
    return () => {
        for (const remove of removals) {
            remove();
        }
    };
};

/** The owner's answer to a contact's task that waited for them (the contact's routes): started, or declined. */
export const decideContactTask = async (deps: Pick<TakingDeps, "link">, row: ContactRow, requestId: string, approve: boolean): Promise<StoredLinkTask | LinkRefusal> => {
    const origin = contactOrigin(row);
    return origin === undefined ? { refused: 404, message: "That contact hands this sandbox no tasks." } : decideTask(deps.link, origin, requestId, approve);
};

/**
 * A task's live status for the contact that handed it over (`task.watch`, a person watching it there): held until its version
 * moves past `after`, `waitS` runs out or the caller goes away, as a link's status read was; undefined for no such task.
 */
export const watchContactTask = async (
    deps: Pick<TakingDeps, "link" | "person">,
    row: ContactRow,
    requestId: string,
    wait: { readonly after?: number | undefined; readonly waitS?: number | undefined },
    signal: AbortSignal,
): Promise<LinkTaskStatus | undefined> => {
    const task = await taskOf(deps, row, requestId);
    if (task === undefined) {
        return undefined;
    }
    const read = () => taskOf(deps, row, requestId);
    const held = { after: wait.after, waitS: wait.waitS ?? 0 };
    return personScoped(row)
        ? heldStatus(deps.person, read, task.conversationId, { ...held, waitsFor: `${row.scope.person}, who is in this sandbox` }, signal)
        : heldStatus(deps.link, read, task.conversationId, held, signal);
};

/** Where a task stands, as the push sends it: a person-scoped contact's cards wait for its person, anything else for the owner. */
export const contactStatusOf = (deps: Pick<TakingDeps, "link" | "person">, row: ContactRow, task: StoredLinkTask): LinkTaskStatus =>
    personScoped(row) ? personStatusOf(deps.person, contactRouteKey(row), task) : statusOf(deps.link, task);
