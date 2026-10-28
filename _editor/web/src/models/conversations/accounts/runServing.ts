import { accountServesLoop } from "@intentic/sandbox-contract/models/agent-catalog";
import { preferredAccount, reopensAtOf } from "@intentic/sandbox-contract/models/plan-pools";
import { type AgentHarness, AgentHarnessSchema, type AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { subscriptionProviderOn } from "../../providers/access";
import { offeredLoops, selectedLoop } from "../../providers/offeredLoops";
import { providerAccounts, translatorAccounts } from "../../providers/providerAccounts";
import { accountFacts, accountState, routedAccountFacts } from "../../providers/usageStatus";
import { type ServingAccount, servingAccount } from "./servingAccount";

/* WHERE A TURN ON ONE PICK RUNS, AND WHAT THAT ACCOUNT'S ALLOWANCE SAYS: the one reading behind the composer's Send and
   every press that starts an agent (a Fix button, a refactor, a new chat's opening words). Each used to answer it its own
   way or not at all: the composer turned Send into a booking for a spent account's reopen, while a run button sent the
   same model's run straight into a refusal (2026-10-28). Reactive: it reads the account lists, their freshest readings
   and every refusal on file, so a computed over it moves when any of them does. */

/** The turn a press would start, as far as who pays for it. */
export interface RunTarget {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    // The model the turn names; empty for the provider's own default.
    readonly model: string;
    // The account the turn names, or the one the conversation's record holds; undefined leaves it to the runtime.
    readonly account?: string | undefined;
    // Whether the turn names `account` (turnRequest.ts accountIntent) rather than leaving it to the conversation's record.
    readonly named?: boolean | undefined;
}

/** Where that turn runs and the verdict on it. */
export interface RunServing {
    // The account it runs on (servingAccount); undefined for a translator's subscription, which balances its own.
    readonly account: ServingAccount | undefined;
    // That account's verdict for the model, or, for a subscription, the pool's: what says a press meets a spent allowance.
    readonly state: AccountState | undefined;
}

// The provider's accounts that could carry the turn, each judged for its model, in the provider's own order (the order
// the daemon breaks ties by): a subscription's credentials, or the native accounts that serve the chosen loop.
const accountRows = (target: RunTarget, subscription: ReturnType<typeof subscriptionProviderOn>) => {
    const model = target.model === `` ? undefined : { id: target.model };
    if (subscription !== undefined) {
        return translatorAccounts.value[subscription].map((entry) => ({ id: entry.name, state: accountState(target.provider, routedAccountFacts(entry), model) }));
    }
    const loop = selectedLoop(offeredLoops(target.provider), target.harness);
    return (providerAccounts.value[target.provider] ?? [])
        .filter((entry) => accountServesLoop(target.provider, loop, entry))
        .map((entry) => ({ id: entry.id, state: accountState(target.provider, accountFacts(entry), model) }));
};

// The translator balances its subscriptions, independently of any account pick: any usable credential keeps the pool
// runnable, and when none can serve, the earliest reopening is the pool's, never the first row's.
const poolState = (rows: readonly { readonly state: AccountState }[]): AccountState | undefined => {
    const preferred = preferredAccount(rows)?.state;
    if (preferred?.kind === `ready` || preferred?.kind === `unknown`) {
        return preferred;
    }
    return rows.reduce<AccountState | undefined>((best, row) => {
        const at = reopensAtOf(row.state);
        const bestAt = best === undefined ? undefined : reopensAtOf(best);
        return at !== undefined && (bestAt === undefined || at < bestAt) ? row.state : best;
    }, preferred);
};

/** Where a turn on `target` runs and that account's verdict, by the daemon's own placement rules (servingAccount). */
export const runServing = (target: RunTarget): RunServing => {
    const subscription = subscriptionProviderOn(target.provider, target.harness);
    const rows = accountRows(target, subscription);
    if (subscription !== undefined) {
        return { account: undefined, state: poolState(rows) };
    }
    const account = servingAccount(target.provider, rows, { account: target.account, named: target.named === true });
    return { account, state: rows.find((row) => row.id === account?.id)?.state };
};

/**
 * When a turn on this verdict should go instead of now (epoch ms): the spent allowance's reopen, while still ahead of
 * `now`. Undefined to go now: room, nothing measured, a spent reading naming no reopening (only the provider can say),
 * or a reopening the clock already passed (a stale reading, which a plain press is the honest answer to).
 */
export const spentUntilOf = (state: AccountState | undefined, now: number): number | undefined => {
    const at = state === undefined ? undefined : reopensAtOf(state);
    return at === undefined || at * 1_000 <= now ? undefined : at * 1_000;
};

/**
 * When a run started now on a run button's pick would start by itself (epoch ms), its allowance spent until then; undefined
 * when it goes now. A fresh conversation has no record, so an account in the pick is one the turn names.
 */
export const runSpentUntil = (
    pick: { readonly provider: string; readonly model: string; readonly account?: string | undefined; readonly harness?: string | undefined },
    now: number,
): number | undefined =>
    spentUntilOf(
        runServing({
            provider: pick.provider,
            // A loop this build does not name is judged as the provider's own: its accounts are the ones that would pay.
            harness: AgentHarnessSchema.catch(`native`).parse(pick.harness ?? `native`),
            model: pick.model,
            account: pick.account,
            named: pick.account !== undefined,
        }).state,
        now,
    );
