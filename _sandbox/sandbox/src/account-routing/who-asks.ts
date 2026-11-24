import { principalsOf } from "../access/principal-chain.js";
import type { Services } from "../composition.js";
import { provesOwner } from "../seams/workload-stamp.js";

/* WHO IS ASKING TO ROUTE (2026-11-24, docs/architecture/account-routing.md). A send names the conversation it comes from
 * in `x-intentic-conversation`, which any turn can write, so the name counts only with its turn proof beside it
 * (seams/workload-stamp.ts provesOwner), as fleet reads believe it (auth/scope/turn-reader.ts). Before this the send took
 * the name unproven, and fell back to the one live conversation: a turn could route as another, and a maintainer's shell
 * or a background job routed as whatever happened to be running.
 * - No proven conversation: nobody. Only a report goes, naming no person: mapping it to the owner would let a shell or a
 *   job route as them.
 * - A proven conversation acts for the people its principal chain names, the owner when it names none (unattended work
 *   is the owner's, as turn-reader.ts reads it). Exactly one person rides the pass; several can only report, unnamed. */

// The people a conversation acts for, its parents' included, lower-cased; empty means the sandbox's owner.
export const peopleFor = (services: Pick<Services, "agents">, conversationId: string): readonly string[] =>
    principalsOf((id) => services.agents.entry(id), conversationId).people;

// Reporting or routing to another sandbox is handing something on, so it rides the same rule as delegating: a turn
// started by outside content, or one whose role does not delegate, has no supervisor armed (children.ts) and may not.
const ROUTE_REFUSED =
    "This turn may not send to another sandbox: it was started by outside content, or its role does not delegate. " +
    "Nothing was sent; say what you saw in your reply instead.";

export interface RouteCaller {
    // The conversation that asked, when the call proved it.
    readonly conversationId?: string;
    // Everyone it acts for, the owner standing in for nobody; empty with no proven conversation.
    readonly people: readonly string[];
    // The one person a routed request goes as: set only when exactly one is in `people`.
    readonly person?: string;
    // Why this turn may not send at all.
    readonly refused?: string;
}

const NOBODY: RouteCaller = { people: [] };

// What the answer reads: the people a conversation acts for, the owner, and whether its turn may hand work on.
export interface RouteCallerDeps {
    readonly peopleOf: (conversationId: string) => readonly string[];
    readonly ownerEmail: () => Promise<string | undefined>;
    readonly mayHandOn: (conversationId: string) => boolean;
}

/** Who a send comes from, given the conversation it names and the proof beside the name. */
export const routeCallerFrom = async (deps: RouteCallerDeps, named: string | undefined, proof: string | undefined): Promise<RouteCaller> => {
    if (named === undefined || named === "" || !provesOwner(named, proof)) {
        return NOBODY;
    }
    if (!deps.mayHandOn(named)) {
        return { conversationId: named, people: [], refused: ROUTE_REFUSED };
    }
    const chain = deps.peopleOf(named);
    const owner = chain.length === 0 ? (await deps.ownerEmail())?.toLowerCase() : undefined;
    const people = owner === undefined ? chain : [owner];
    const person = people.length === 1 ? people[0] : undefined;
    return person === undefined ? { conversationId: named, people } : { conversationId: named, people, person };
};
