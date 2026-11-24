import { providerHas } from "@intentic/sandbox-contract/models/providers/provider-traits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { Services } from "../../../composition.js";
import { FIRST_RECHECK_MS, LONGEST_RECHECK_MS } from "../claude/claude-seat-check.js";
import { judgedAccounts } from "../../../usage/serviceability/serviceability.js";
import { moveTarget, type PlaceDeps } from "./placement.js";

// Before moving/holding an implicitly remembered unserviceable account, ration a Claude seat recheck; an answer clears the mark.
// Explicit account intent still attempts it (picker, automation, named press or booked move), allowing the real refusal or recovery to speak.
// Check during planning because named credential routing is unfiltered. Spent, reconnect-required and temporary benches use their own wait/fix paths.

// The seat's re-test is Claude's alone (agent/providers/claude/claude-seat-check.ts); every provider's accounts are judged
// by the one rule, which reads a Cursor account refused outright (`[role_forbidden]`) off the refusal ledger.
export type BlockedAccountDeps = PlaceDeps & Pick<Services, "claudeSeatCheck">;

export type AccountRoute =
    // Run where routingFor points. `servable` marks a blocked account whose seat a re-test just found back on, which lets
    // words its refusal held go again by themselves (account-refusal-release.ts); records alone never prove that.
    | { readonly kind: "keep"; readonly servable?: true }
    // Moved to a ready account of the same provider; the conversation follows (switchAccount's profile write). `reach`
    // marks a move off an account the people it works for may not use (agent/run/decide/account-reach.ts) rather than
    // one that cannot serve; `spent` a move off one the records call spent (account-placement.ts offSpentAccount), which
    // a person's own pick overrides; `cold` a move off one that can serve, onto one with clearly more room, made because the
    // cache had expired (account-placement.ts). `labels` are both accounts' own names, read with their verdicts, for the
    // row the move leaves in the chat (turn-plan.ts), which names accounts, never ids.
    | {
          readonly kind: "move";
          readonly from: string;
          readonly to: string;
          readonly labels: AccountLabels;
          readonly reason: string;
          readonly reach?: true;
          readonly spent?: true;
          readonly cold?: true;
      }
    // Nothing of the provider's can serve: refused before anything spawns, the words held for a press.
    | { readonly kind: "held"; readonly account: string; readonly reason: string };

/** The two accounts of a move by their own names. */
export interface AccountLabels {
    readonly from: string;
    readonly to: string;
}

const KEEP: AccountRoute = { kind: "keep" };
const SERVABLE: AccountRoute = { kind: "keep", servable: true };

/**
 * Where a turn goes when the account its conversation remembers is blocked. `named` is the account the turn itself
 * names, `remembered` the one routingFor fills in from the conversation's profile. Any provider whose accounts a turn
 * names (a routed provider's conversation is bound to none: the daemon's gateway places each of its requests,
 * translator-gateway.ts): Claude's carry the seat marks, and every one's the entitlement refusals on file.
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
    if (named !== undefined || remembered === undefined || KeyedProviderSchema.safeParse(provider).success) {
        return KEEP;
    }
    // One reading for both questions, judged for the model the turn spends, as the limit move's destination is.
    const accounts = await judgedAccounts(deps, provider, model === undefined || model === "" ? undefined : { id: model });
    const current = accounts.find((account) => account.id === remembered);
    const state = current?.state;
    if (state?.kind !== "blocked" || state.fix !== "admin") {
        return KEEP;
    }
    // Access an admin turned back on is found here, when the probe is due; the turn then runs where it was routed.
    const probed = providerHas(provider, "seatProbe");
    if (probed && (await deps.claudeSeatCheck.recheck(remembered))) {
        return SERVABLE;
    }
    // Proven room; where the plan publishes no reading to prove any (Cursor's, Devin's), or every account with a reading
    // is refused, an account nothing has refused: the move every subsystem makes (placement.ts moveTarget, over the rule
    // the limit move and the editor's offer read too, account-moves.ts).
    const to = await moveTarget(
        deps,
        provider,
        model,
        accounts.filter((account) => account.id !== remembered),
    );
    if (to !== undefined) {
        return { kind: "move", from: remembered, to: to.id, labels: { from: current?.label ?? remembered, to: to.label }, reason: state.reason };
    }
    // With nowhere to go, only an account a probe re-tests is held for it; any other runs where it was routed and is
    // refused in a second, which tells whoever asked, since a hold nothing re-tests would wait out a day.
    return probed ? { kind: "held", account: remembered, reason: state.reason } : KEEP;
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
