import { uuidv7 } from "@intentic/sandbox-contract/s2s";
import type { S2sPayload } from "@intentic/sandbox-contract/schemas/s2s";
import type { ContactSends, Delivery } from "../../links/contact-children.js";
import type { LinkedChildren } from "../../links/linked-children.js";
import { opt } from "../../opt.js";
import { type AskerDeps, turnAskerOf } from "../askers.js";
import type { ContactRow, ContactsStore } from "../contacts/contacts-store.js";
import type { S2sKinds } from "../messages/kinds.js";
import type { OutboxEntry, S2sOutbox, Settled } from "../messages/outbox.js";

/* THE ASKING SIDE OF A CONTACT'S TASK, over this daemon's contacts and outbox (2026-11-27, messages.md "Tasks"): which
 * contacts a conversation may hand tasks to, each `task.*` message filed in the one outbox with its first attempt waited
 * on, and the `task.update` kind moving the roster record (links/contact-children.ts holds what the asking side does). */

// The kinds this side sends; one of them let go undelivered after its first attempt is said on its task.
const SENT_KINDS: ReadonlySet<S2sPayload["kind"]> = new Set(["task.request", "task.message", "task.answer", "task.stop"]);

export interface ContactSendsDeps {
    // Read when asked: the s2s service is composed beside the links that use this.
    readonly contacts: () => Pick<ContactsStore, "get" | "list">;
    readonly outbox: () => Pick<S2sOutbox, "enqueue" | "list">;
    readonly askers: () => AskerDeps;
    readonly now?: () => number;
}

export interface ContactSendsHub extends ContactSends {
    // What one outbox attempt came to: answers whether a send was waiting on it (its first attempt), so a caller hears
    // the rest as late.
    readonly settled: (entry: OutboxEntry, settled: Settled) => boolean;
}

const deliveryOf = (settled: Settled): Delivery =>
    settled.state === "sent" ? { state: "sent" } : settled.state === "undelivered" ? { state: "refused", reason: settled.reason } : { state: "waiting", reason: settled.reason };

// Sandbox-scoped contacts for a turn acting for a maintainer; a person-scoped one for a turn acting for that one person
// alone, as a person route is (links/person-routes.ts), since the task then runs as them.
const usableBy = (asker: Awaited<ReturnType<typeof turnAskerOf>>, row: ContactRow): boolean =>
    row.scope.kind === "sandbox" ? asker.maintainer : asker.people.length === 1 && asker.people[0] === row.scope.person.toLowerCase();

export const contactSendsOf = (deps: ContactSendsDeps): ContactSendsHub => {
    const now = deps.now ?? Date.now;
    const waiting = new Map<string, (delivery: Delivery) => void>();
    return {
        usable: async (conversationId) => {
            const asker = await turnAskerOf(deps.askers(), conversationId);
            return (await deps.contacts().list()).filter((row) => row.state === "accepted" && usableBy(asker, row));
        },
        get: (contactId) => deps.contacts().get(contactId),
        send: async (contact, payload, { hops, waitMs }) => {
            // Minted here so the wait is set before the outbox's first attempt can answer.
            const id = uuidv7(now());
            const first =
                waitMs <= 0
                    ? undefined
                    : new Promise<Delivery>((resolve) => {
                          waiting.set(id, resolve);
                          setTimeout(() => {
                              if (waiting.delete(id)) {
                                  resolve({ state: "waiting" });
                              }
                          }, waitMs).unref();
                      });
            const queued = await deps.outbox().enqueue({ id, contact, payload, ...opt("hops", hops) });
            if ("refused" in queued) {
                waiting.delete(id);
                return { state: "refused", reason: queued.refused };
            }
            return first ?? { state: "waiting" };
        },
        requestQueued: async (contactId, requestId) =>
            (await deps.outbox().list()).some(
                (entry) => entry.state === "waiting" && entry.contact === contactId && entry.payload.kind === "task.request" && entry.payload.requestId === requestId,
            ),
        settled: (entry, settled) => {
            const resolve = waiting.get(entry.id);
            if (resolve === undefined) {
                return false;
            }
            waiting.delete(entry.id);
            resolve(deliveryOf(settled));
            return true;
        },
    };
};

/**
 * The asking side's ears: `task.update` moves the record of the task it names, taken before the far side is answered so
 * a stop in between cannot lose it (the far side's outbox would read the answer as delivered); and every `task.*` message
 * let go undelivered once nobody waits on its first attempt is said on its task.
 */
export const registerAskingKinds = (
    kinds: Pick<S2sKinds, "register">,
    outbox: Pick<S2sOutbox, "onSettled">,
    hub: Pick<ContactSendsHub, "settled">,
    children: Pick<LinkedChildren, "heard" | "refused">,
): (() => void) => {
    outbox.onSettled(async (entry, settled) => {
        if (!hub.settled(entry, settled) && settled.state === "undelivered" && SENT_KINDS.has(entry.payload.kind)) {
            await children.refused(entry.contact, entry.payload, settled.reason);
        }
    });
    return kinds.register("task.update", async (received) => {
        if (received.contact === undefined) {
            return { refused: "not_contact", error: "only a contact sends a task's status" };
        }
        await children.heard(received.contact.id, received.payload.task, received.payload.status);
        return { stored: true };
    });
};
