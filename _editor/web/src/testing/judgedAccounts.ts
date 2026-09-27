import {
    type AccountState,
    type OauthAccount,
    type ProviderRefusal,
    type ServiceFacts,
    serviceStates,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import { providerAccounts, providerRefusals, translatorAccounts } from "../features/chat/accounts/providerAccounts";
import { accountFacts, routedAccountFacts } from "../features/chat/session/usageStatus";

// Account rows as a current daemon lists them: each carries the verdict it was judged by (`state`, the daemon's
// withAccountStates), from the contract's one rule over the row's own facts and the provider's standing refusal. The
// editor never judges a row itself, so a suite that builds rows by hand stamps them here. A row given a `state` keeps it.

// Rows this module stamped, judged again on the next call (a suite may have set a refusal since); a suite's own `state`
// never is.
const stamped = new WeakSet<object>();

const judged = <T extends { readonly state?: AccountState | undefined }>(
    rows: readonly T[],
    factsOf: (row: T) => ServiceFacts,
    refusal: ProviderRefusal | undefined,
    now: number,
): T[] => {
    const states = serviceStates(rows.map(factsOf), refusal, undefined, now);
    return rows.map((row) => {
        const state = (stamped.has(row) ? undefined : row.state) ?? states.get(factsOf(row).account);
        if (state === undefined) {
            return row;
        }
        const next = { ...row, state };
        stamped.add(next);
        return next;
    });
};

/** A provider's own account rows, judged as the daemon lists them. */
export const judgedOauth = (rows: readonly OauthAccount[], refusal?: ProviderRefusal, now: number = Date.now()): OauthAccount[] =>
    judged(rows, accountFacts, refusal, now);

/** Every row in the account stores, judged against the refusals the store holds: call once a suite has filled them. */
export const judgeAccountStores = (now: number = Date.now()): void => {
    const refusals = providerRefusals.value;
    providerAccounts.value = Object.fromEntries(
        Object.entries(providerAccounts.value).map(([provider, rows]) => [provider, judged(rows, accountFacts, refusals[provider], now)]),
    );
    // SAFETY: the entries are the store's own, one per routed provider, each judged in place; fromEntries only loses the keys' names.
    translatorAccounts.value = Object.fromEntries(
        Object.entries(translatorAccounts.value).map(([provider, rows]) => [provider, judged(rows, routedAccountFacts, refusals[provider], now)]),
    ) as TranslatorAccounts;
};
