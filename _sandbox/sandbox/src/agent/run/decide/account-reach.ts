import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { type AccountReach, accountReachAllows, reachWho } from "../../../secrets/credential-reach.js";
import { namedServiceabilities, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import type { AccountRoute } from "../../providers/accounts/blocked-account.js";

/* WHICH ACCOUNT A TURN MAY RUN ON, as everyone its conversation acts for may (Access ▸ People, a person's AI accounts:
   auth.ts `Member.aiAccounts`; a service's access profile; a bound organisation's ceiling; read live through
   secrets/credential-reach.ts `AccountReach`, docs/architecture/access.md).

   Asked after the blocked-account route, of the account the turn would run on as routed, and enforced there rather than
   told to the model, since the account is the one thing a turn spends before any tool runs:
   - an account the turn NAMES (a hand pick in the composer, an automation's, a booked move) outside the reach is refused:
     somebody chose it, so it is not quietly swapped for another;
   - an account the CONVERSATION remembers outside the reach (somebody else started it, or an owner narrowed the list
     since) is moved off, onto the account the provider's own rule would pick among the ones inside it, as a blocked
     account is (blocked-account.ts), so a person joining a conversation runs on what is theirs;
   - a turn LEFT TO THE SANDBOX'S PICK where the reach holds only some of the provider's accounts is pinned to that pick,
     so no runtime's own picker (harness-credentials.ts, cursor-usage.ts, a CLI's first account) can land elsewhere;
   - with no account of the provider inside the reach, the turn is refused, naming the accounts that are.
   A provider holding no accounts of its own (an API-key endpoint, an installed agent, the free trial) is judged whole by
   its own key; a local model spends nobody's allowance and is never held back. */

/** The route a turn takes once the reach has been asked: the blocked-account route's answers, and two of its own. */
export type ReachedRoute =
    | AccountRoute
    // Left to the sandbox's pick and narrowed to one account inside the reach; the session frame latches it as it would
    // any pick, so nothing is written for the conversation here.
    | { readonly kind: "pin"; readonly to: string }
    // Not sent: the people this conversation works for may not run it on that account, or on any of the provider's.
    | { readonly kind: "refused"; readonly message: string; readonly account?: string };

export interface ReachTurn {
    readonly provider: AgentProvider;
    // What the turn itself names; undefined is no choice made for this turn.
    readonly named: string | undefined;
    // What the conversation's profile fills in where the turn names none (routing.ts `routingFor`).
    readonly remembered: string | undefined;
    readonly model: string | undefined;
    // The provider is a local model: nobody's allowance is spent on it.
    readonly free: boolean;
}

interface NamedRow {
    readonly id: string;
    readonly label: string;
    readonly state: AccountState;
}

// The account a turn left to the sandbox runs on among the ones it may use: the provider's own rule, which for every
// provider reads the same verdicts (ready by most room, then unmeasured, then spent), and ties keep the provider's order.
const pickAmong = (allowed: readonly NamedRow[]): NamedRow | undefined => preferredAccount(allowed) ?? allowed[0];

const listed = (rows: readonly NamedRow[]): string => rows.map((row) => `"${row.label}"`).join(", ");

const UNREADABLE =
    "The sandbox's record of who this conversation acts for (its roster, services or access profiles) could not be read, so which AI accounts it may run on is unknown, and no turn is run on a guess. Try again in a moment; if it keeps happening, tell the sandbox owner.";

// What every refusal ends with: who decides, and what to do instead.
const OWNER_DECIDES =
    "The sandbox owner, or someone who runs people and access, changes which AI accounts a person or a service may use, on the Access page; an account a person connected themselves is always theirs.";

const notAllowed = (reach: Extract<AccountReach, { kind: "some" }>, label: string, what: string, allowed: readonly NamedRow[]): string =>
    `${reach.who.length > 1 ? `${reachWho(reach.who)} were` : `${reachWho(reach.who)} was`} not given ${what}, and a conversation runs only on AI accounts everyone it acts for may use. ${ 
    allowed.length === 0 ? `No ${label} account is available to this conversation: pick another model in the composer. ` : `Pick ${allowed.length === 1 ? "it" : "one of them"} in the composer: ${listed(allowed)}. ` 
    }${OWNER_DECIDES}`;

/**
 * Where a turn goes once the reach is asked. `route` is the blocked-account route already decided, which a reach can
 * only narrow: its hold stands, its move stands where the destination is inside the reach and is re-aimed where not.
 */
export const routeWithinReach = async (deps: ServiceabilityDeps, reach: AccountReach, turn: ReachTurn, route: AccountRoute): Promise<ReachedRoute> => {
    if (reach.kind === "all" || turn.free || route.kind === "held") {
        return route;
    }
    const { provider, named, remembered } = turn;
    const label = providerLabel(provider);
    if (reach.unreadable !== undefined) {
        return { kind: "refused", message: UNREADABLE };
    }
    const rows = await namedServiceabilities(deps, provider, turn.model === undefined || turn.model === "" ? undefined : { id: turn.model });
    // No account of its own: an endpoint, an installed agent, the trial, or a provider with nothing connected, judged whole.
    if (rows.length === 0) {
        return accountReachAllows(reach, provider, undefined) ? route : { kind: "refused", message: notAllowed(reach, label, label, []) };
    }
    const allowed = rows.filter((row) => accountReachAllows(reach, provider, row.id));
    const routed = route.kind === "move" ? route.to : (named ?? remembered);
    if (routed === undefined) {
        // Left to the pick: unchanged where every account is inside the reach, else pinned to the pick among those that are.
        if (allowed.length === rows.length) {
            return route;
        }
        const pick = pickAmong(allowed);
        return pick === undefined ? { kind: "refused", message: notAllowed(reach, label, `any ${label} account`, []) } : { kind: "pin", to: pick.id };
    }
    if (allowed.some((row) => row.id === routed)) {
        return route;
    }
    const name = rows.find((row) => row.id === routed)?.label ?? routed;
    if (named !== undefined) {
        return { kind: "refused", message: notAllowed(reach, label, `the ${label} account "${name}"`, allowed), account: named };
    }
    const pick = pickAmong(allowed);
    if (pick === undefined) {
        return { kind: "refused", message: notAllowed(reach, label, `any ${label} account`, []), account: routed };
    }
    // The move starts from where the conversation was, whichever account the blocked route had meant to send it to.
    const from = route.kind === "move" ? { id: route.from, label: route.labels.from } : { id: routed, label: name };
    return {
        kind: "move",
        from: from.id,
        to: pick.id,
        labels: { from: from.label, to: pick.label },
        reason: `"${name}" is not among the AI accounts ${reachWho(reach.who)} may use`,
        reach: true,
    };
};
