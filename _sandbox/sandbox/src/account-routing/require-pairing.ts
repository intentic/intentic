import type { PassScope } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import type { ContactRow } from "../s2s/contacts/contacts-store.js";
import type { RouteTarget } from "./route-client.js";
import { routeSecretsOf } from "./route-secrets.js";
import { routeNeedTitle, routeSubject } from "./route-subject.js";

// THE SENDING SIDE'S PAIRING, for every routed scope but a report (2026-11-24, docs/architecture/account-routing.md):
// the secret the person minted at the target, or the `route` card raised in the sending conversation asking them for it.
// What a drop, a read or a task calls before it sends, and again when the far side refuses with `code: "pairing"` (the
// person took it back there): `forget` drops the secret here so the card can ask again.
// A person who already reaches the target through a contact of their own (person-scoped, accepted: a pairing upgraded,
// or a contact paired in the editor, docs/architecture/messages.md) is asked for nothing: nothing new is minted toward a
// sandbox that speaks s2s/1, and the send is told to go over the contact instead (2026-11-27).

export type Pairing =
    | { readonly secret: string }
    | { readonly asked: string; readonly needId: string }
    | { readonly contact: string; readonly refused: string };

/** The person's own accepted contact for the target sandbox (its tunnel id), when they have one. */
export const personContactFor = async (s2s: Pick<Services["s2s"], "contacts">, target: string, person: string): Promise<ContactRow | undefined> =>
    (await s2s.contacts.list()).find(
        (row) => row.state === "accepted" && row.scope.kind === "person" && row.scope.person.toLowerCase() === person.toLowerCase() && row.document.sandbox === target,
    );

/** The secret for routing as `person` into `target`, or the card that now asks them for it (the sentence to tell the agent). */
export const requirePairing = async (
    services: Pick<Services, "config" | "workspace" | "needs" | "s2s">,
    ask: { readonly conversationId: string; readonly target: RouteTarget; readonly person: string; readonly scopes: readonly PassScope[] },
): Promise<Pairing> => {
    const secret = await routeSecretsOf(services).secretFor(ask.target.sandboxId, ask.person);
    if (secret !== undefined) {
        return { secret };
    }
    const contact = await personContactFor(services.s2s, ask.target.sandboxId, ask.person);
    if (contact !== undefined) {
        return {
            contact: contact.id,
            refused: `${ask.person} reaches ${ask.target.name} through a contact of their own here ("${contact.name ?? contact.document.name}"): send it over that contact (\`messages send\`, or \`delegate\` to it) rather than routed. Nothing was sent, and nothing needs allowing.`,
        };
    }
    const subject = routeSubject(ask.target, ask.person, ask.scopes, sandboxIdFromToken(services.config.connectToken));
    const need = await services.needs.observe(ask.conversationId, subject, routeNeedTitle(subject));
    return {
        asked: `${ask.person} has not allowed this sandbox to act as them in ${ask.target.name}: a card asks them now (need ${need.id}). Nothing was sent; carry on with what does not need it.`,
        needId: need.id,
    };
};

/** Drops the secret for (target, person), after the target said it no longer holds the pairing. */
export const forgetPairing = (services: Pick<Services, "config" | "workspace">, target: string, person: string): Promise<void> =>
    routeSecretsOf(services).remove(target, person);
