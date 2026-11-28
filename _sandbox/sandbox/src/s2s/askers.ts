import { type MemberTier, tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { S2sContactScope } from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { provesOwner } from "../seams/workload-stamp.js";

// WHO ASKS, at the Messages tab's routes and the `messages` command's (docs/architecture/messages.md, "Scope" and "The
// inbox"): a person signed in, or a turn proving which conversation it is (its people from its principal chain, the
// owner when it names none, as account-routing/who-asks.ts reads them), or nobody: a shell naming no conversation, which
// sees nothing. What each may see and use:
// - a sandbox-scoped contact, and its threads: the owner and maintainers, and a turn acting for one of them;
// - a person-scoped contact, and its threads: that person, and a turn acting for them; maintainers read its threads too
//   (the drops' rule), but list and use only their own person-scoped contacts.

export type S2sAsker =
    | { readonly kind: "person"; readonly email: string; readonly maintainer: boolean }
    | { readonly kind: "turn"; readonly conversationId: string; readonly people: readonly string[]; readonly maintainer: boolean }
    | { readonly kind: "nobody" };

const NOBODY: S2sAsker = { kind: "nobody" };

export interface AskerDeps {
    // The people a conversation acts for, lower-cased; empty means the sandbox's owner.
    readonly peopleOf: (conversationId: string) => readonly string[];
    readonly ownerEmail: () => Promise<string | undefined>;
    // A person's tier on the roster now, when they are on it.
    readonly tierOf: (email: string) => Promise<MemberTier | undefined>;
}

/** Who asks at a route: the signed-in person, a proven turn and the people it acts for, or nobody. */
export const askerOf = async (deps: AskerDeps, c: Pick<Context<AppEnv>, "get" | "req">): Promise<S2sAsker> => {
    const identity = c.get("identity");
    if (identity !== undefined) {
        return { kind: "person", email: identity.email.toLowerCase(), maintainer: tierAtLeast(identity.tier, "maintainer") };
    }
    const named = c.req.header("x-intentic-conversation");
    if (named === undefined || named === "" || !provesOwner(named, c.req.header("x-intentic-turn-proof"))) {
        return NOBODY;
    }
    return turnAskerOf(deps, named);
};

/** A conversation's turn as an asker: the people it acts for (the owner when its chain names none), and their standing. */
export const turnAskerOf = async (deps: AskerDeps, conversationId: string): Promise<Extract<S2sAsker, { kind: "turn" }>> => {
    const chain = deps.peopleOf(conversationId).map((person) => person.toLowerCase());
    const owner = chain.length === 0 ? (await deps.ownerEmail())?.toLowerCase() : undefined;
    const people = owner === undefined ? chain : [owner];
    const tiers = await Promise.all(people.map((person) => deps.tierOf(person)));
    return { kind: "turn", conversationId, people, maintainer: tiers.some((tier) => tier !== undefined && tierAtLeast(tier, "maintainer")) };
};

const speaksFor = (asker: S2sAsker, person: string): boolean =>
    (asker.kind === "person" && asker.email === person.toLowerCase()) || (asker.kind === "turn" && asker.people.includes(person.toLowerCase()));

/** Whether the asker may list, send over and change a contact of this scope. */
export const mayUse = (asker: S2sAsker, scope: S2sContactScope): boolean =>
    asker.kind !== "nobody" && (scope.kind === "sandbox" ? asker.maintainer : speaksFor(asker, scope.person));

/** Whether the asker reads the threads of a contact of this scope: as `mayUse`, and a signed-in maintainer reads every one. */
export const mayRead = (asker: S2sAsker, scope: S2sContactScope): boolean => mayUse(asker, scope) || (asker.kind === "person" && asker.maintainer);
