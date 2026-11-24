import type { PassScope } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import type { RouteTarget } from "./route-client.js";
import { routeSecretsOf } from "./route-secrets.js";
import { routeNeedTitle, routeSubject } from "./route-subject.js";

// THE SENDING SIDE'S PAIRING, for every routed scope but a report (2026-11-24, docs/architecture/account-routing.md):
// the secret the person minted at the target, or the `route` card raised in the sending conversation asking them for it.
// What a drop, a read or a task calls before it sends, and again when the far side refuses with `code: "pairing"` (the
// person took it back there): `forget` drops the secret here so the card can ask again.

export type Pairing = { readonly secret: string } | { readonly asked: string; readonly needId: string };

/** The secret for routing as `person` into `target`, or the card that now asks them for it (the sentence to tell the agent). */
export const requirePairing = async (
    services: Pick<Services, "config" | "workspace" | "needs">,
    ask: { readonly conversationId: string; readonly target: RouteTarget; readonly person: string; readonly scopes: readonly PassScope[] },
): Promise<Pairing> => {
    const secret = await routeSecretsOf(services).secretFor(ask.target.sandboxId, ask.person);
    if (secret !== undefined) {
        return { secret };
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
