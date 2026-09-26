import { type AgentProvider, providerLabel, roomiestAccount } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import { FIRST_RECHECK_MS, LONGEST_RECHECK_MS } from "../../../runtimes/claude/claude-seat-check.js";
import { serviceabilities, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";

// A turn that runs on the account its conversation remembers, when that account can no longer serve: an organisation
// took the seat away, or the provider refused the account's entitlement. The unnamed pick never lands there (the one
// serviceability rule ranks it last), but every later turn of a conversation names its account through routingFor, and
// a named account is never filtered where the credential is minted. So the check is made here, where the turn is
// planned, for every turn that did not name its account itself: a person's next message, a wake, a queued batch, a
// held turn pressed with no account.
//
// Before a turn is moved or held, the mark is re-tested (claudeSeatCheck, rationed per account): once turns are kept off
// the account, no turn runs there to clear it. A probe that gets an answer lifts the mark and the turn stays on the account.
//
// A turn that names its account runs on it whatever its state, and a refusal then says why; an answer lifts the mark
// (providerAnswered). Such a turn is the composer's pick for this turn (a person picking the marked account again is an
// attempt, turnRequest.ts accountIntent), an automation's configured account, a press naming one, or a booked limit move.
// A spent account is the limit move's (bookLimitMove), a revoked sign-in is fixed in place by reconnecting (its refusal
// holds the turn for that), and a bench that lifts by itself is waited out; none of those moves a conversation here.

// The seat's re-test is Claude's alone (runtimes/claude/claude-seat-check.ts).
export type BlockedAccountDeps = ServiceabilityDeps & Pick<Services, "claudeSeatCheck">;

export type AccountRoute =
    // Run where routingFor points.
    | { readonly kind: "keep" }
    // Moved to a ready account of the same provider; the conversation follows (switchAccount's profile write).
    | { readonly kind: "move"; readonly from: string; readonly to: string; readonly reason: string }
    // Nothing of the provider's can serve: refused before anything spawns, the words held for a press.
    | { readonly kind: "held"; readonly account: string; readonly reason: string };

const KEEP: AccountRoute = { kind: "keep" };

/**
 * Where a turn goes when the account its conversation remembers is blocked. `named` is the account the turn itself
 * names, `remembered` the one routingFor fills in from the conversation's profile. Claude only: a routed provider's
 * translator balances its own credentials, and only Claude's accounts carry the seat and entitlement marks.
 */
export const offBlockedAccount = async (
    deps: BlockedAccountDeps,
    turn: {
        readonly provider: AgentProvider;
        readonly named: string | undefined;
        readonly remembered: string | undefined;
        readonly model: string | undefined;
    },
): Promise<AccountRoute> => {
    const { provider, named, remembered, model } = turn;
    if (named !== undefined || remembered === undefined || provider !== "claude") {
        return KEEP;
    }
    // One reading for both questions, judged for the model the turn spends, as the limit move's destination is.
    const accounts = await serviceabilities(deps, provider, model === undefined || model === "" ? undefined : { id: model });
    const state = accounts.find((account) => account.id === remembered)?.state;
    if (state?.kind !== "blocked" || state.fix !== "admin") {
        return KEEP;
    }
    // Access an admin turned back on is found here, when the probe is due; the turn then runs where it was routed.
    if (await deps.claudeSeatCheck.recheck(remembered)) {
        return KEEP;
    }
    const to = roomiestAccount(accounts.filter((account) => account.id !== remembered))?.id;
    return to === undefined ? { kind: "held", account: remembered, reason: state.reason } : { kind: "move", from: remembered, to, reason: state.reason };
};

const minutes = (ms: number): number => Math.round(ms / 60_000);

// The words a turn held for want of an account is refused with: the provider's own reason, then what works from there.
// Sending again in the ordinary way names no account, so it is held again until the rationed re-check finds access
// back; picking the account in the composer names it, so the turn is tried on it at once.
export const heldForAccountMessage = (provider: AgentProvider, reason: string): string => {
    const said = reason.trim();
    const label = providerLabel(provider);
    return (
        `The ${label} account this conversation runs on cannot serve it: ${said}${/[.!?]$/.test(said) ? "" : "."} ` +
        `No other connected ${label} account can serve right now. Once your organisation's admin turns access back on, ` +
        `pick this account again in the composer and send, and the message is tried on it at once. A plain send re-checks ` +
        `the account by itself, first ${minutes(FIRST_RECHECK_MS)} minutes after the refusal, then with gaps growing to ` +
        `${minutes(LONGEST_RECHECK_MS)} minutes. Or connect another ${label} account in Sandbox ▸ Agent.`
    );
};
