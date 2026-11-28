import { PASS_SCOPES, type PassScope } from "@intentic/sandbox-contract/protocol/doors/pass-scopes";
import type { Need, NeedAsk, NeedSubject, RouteNeed } from "@intentic/sandbox-contract/schemas/needs";
import type { RouteAnswer } from "../../account-routing/route-client.js";
import { routeNeedTitle, routeSubject } from "../../account-routing/route-subject.js";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { routeClientOf } from "../../account-routing/route-client.js";
import { personContactFor } from "../../account-routing/require-pairing.js";
import { routeSecretsOf } from "../../account-routing/route-secrets.js";
import { peopleFor } from "../../account-routing/who-asks.js";
import type { Services } from "../../composition.js";
import type { AskContext, Answerer, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A person's leave for this sandbox to route as them into another (docs/architecture/account-routing.md, 2026-11-24):
// every scope but a report is admitted over there only beside a pairing secret that person minted there for this
// sandbox. Only they can give it, and only from an editor signed in to both sandboxes: the card's press mints the secret
// at the target (`POST /account/pairings` there), keeps it here (`POST /account/routes/secret`), then answers the need.
// Raised by a send that found no secret for (target, person) (account-routing/require-pairing.ts), or by an agent asking
// ahead (`needs ask route`); met once this sandbox holds a secret for the pair, however it got there, or the person's own
// contact for the target (2026-11-27, messages.md: the editor pairs a contact there instead once both speak s2s/1).

export interface RouteNeedDeps {
    // The one person the raising conversation acts for, or why it cannot route as anyone.
    readonly personOf: (conversationId: string) => Promise<{ readonly person: string } | { readonly refused: string }>;
    // Where the platform says the target is, for that person.
    readonly locate: (target: string, person: string, scope: PassScope) => Promise<RouteAnswer>;
    // Whether this sandbox holds a secret for (target's tunnel id, person), or that person's own accepted contact there.
    readonly held: (target: string, person: string) => Promise<boolean>;
    // This sandbox's own tunnel id, which the target keys the pairing on.
    readonly self: () => string | undefined;
}

const ROUTED: readonly PassScope[] = PASS_SCOPES.filter((scope) => scope !== "report");

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const metFor = (subject: Pick<RouteNeed, "targetName" | "person" | "scopes">): Met => ({
    result: `${subject.person} allowed this sandbox to ${subject.scopes.join(", ")} in ${subject.targetName} as them.`,
    use: ["Send again: what goes there now carries their pairing, and is admitted as them."],
});

export const routeNeed = (deps: RouteNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): RouteNeed | undefined => (need.subject.kind === "route" ? need.subject : undefined);

    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "route") {
            return { kind: "refused", code: "invalid", message: "Not a route ask." };
        }
        const scopes = (ask.scopes ?? ROUTED).filter((scope) => scope !== "report");
        if (scopes.length === 0) {
            return { kind: "met", message: "A report needs no pairing: `projects report` sends it as it is." };
        }
        const who = await deps.personOf(context.conversationId);
        if ("refused" in who) {
            return { kind: "refused", code: "no_person", message: `Nothing was asked: ${who.refused}` };
        }
        const located = await deps.locate(ask.target, who.person, scopes[0] ?? "drop");
        if (!located.ok) {
            return { kind: "refused", code: "unrouted", message: `Nothing was asked: ${located.message}.` };
        }
        const subject = routeSubject(located.value, who.person, scopes, deps.self());
        if (await deps.held(subject.target, subject.person)) {
            return { kind: "met", message: metFor(subject).result };
        }
        return { kind: "raise", subject, title: routeNeedTitle(subject) };
    };

    return {
        resolve,
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            return subject !== undefined && (await deps.held(subject.target, subject.person)) ? metFor(subject) : undefined;
        },
        // Their leave, so theirs alone to give or refuse; anyone else reads whom it waits on.
        mayAnswer: (need, by) => {
            const subject = subjectOf(need);
            if (subject === undefined || (by.email !== undefined && sameEmail(by.email, subject.person))) {
                return undefined;
            }
            return `Only ${subject.person} can answer this: it is their leave to act as them in ${subject.targetName}.`;
        },
        // The card's press has already minted the secret there and kept it here; this only confirms it took.
        answer: async (need, answer, by: Answerer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A route is answered by allowing it, or declined." };
            }
            if (by.email === undefined || !sameEmail(by.email, subject.person)) {
                return { refused: `Only ${subject.person} can allow this.` };
            }
            if (!(await deps.held(subject.target, subject.person))) {
                return { refused: `This sandbox holds no pairing for ${subject.targetName} yet: press Allow again, signed in to both sandboxes.` };
            }
            return { status: "met", ...metFor(subject) };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "route" ? `${subject.target}\u0000${subject.person.toLowerCase()}` : ""),
    };
};

/** The `route` need kind, wired to this daemon. */
export const routeNeedOf = (whole: () => Services) =>
    routeNeed({
        personOf: async (conversationId) => {
            const people = peopleFor(whole(), conversationId);
            if (people.length > 1) {
                return { refused: "this conversation acts for more than one person, so it routes as none of them" };
            }
            const person = people[0] ?? (await whole().ownerEmail());
            return person === undefined ? { refused: "this sandbox has no owner yet to route as" } : { person: person.toLowerCase() };
        },
        locate: (target, person, scope) => routeClientOf(whole()).routeTo({ scope, person, sandbox: target }),
        held: async (target, person) =>
            (await routeSecretsOf(whole()).secretFor(target, person)) !== undefined || (await personContactFor(whole().s2s, target, person)) !== undefined,
        self: () => sandboxIdFromToken(whole().config.connectToken),
    });
