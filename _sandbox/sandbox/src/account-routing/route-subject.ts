import type { PassScope } from "@intentic/sandbox-contract/sandbox-pass";
import type { RouteNeed } from "@intentic/sandbox-contract/schemas/needs";
import { opt } from "../opt.js";

// The `route` card's subject and title (needs/kinds/route-need.ts), here so the sending side raises it without reaching up
// into the needs layer.

/** The card's title: whose leave, for which sandbox. */
export const routeNeedTitle = (subject: Pick<RouteNeed, "targetName" | "person">): string => `Let this sandbox act as ${subject.person} in ${subject.targetName}`;

/** The subject a send raises, from the platform's answer for the target. */
export const routeSubject = (target: { readonly sandboxId: string; readonly name: string; readonly address: string }, person: string, scopes: readonly PassScope[], self: string | undefined): RouteNeed => ({
    kind: "route",
    target: target.sandboxId,
    targetName: target.name,
    person: person.toLowerCase(),
    scopes: [...scopes],
    address: target.address,
    ...opt("from", self),
});

