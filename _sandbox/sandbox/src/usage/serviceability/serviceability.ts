import {
    type AccountState,
    type AgentProvider,
    KeyedProviderSchema,
    type ModelRef,
    type OauthAccount,
    type ServiceFacts,
    serviceStates,
    type TranslatorAccount,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";

// "Can this account serve a turn?", answered in one place. The rule itself is the contract's (`serviceState` in
// models/plan-pools.ts); this module feeds it every fact the daemon holds: revoke marks and seat refusals, the plan-limit
// reading (its `unread` mark included, the reading stays a floor), the provider's last refusal, and the translator's
// bench. The unnamed-turn pick, the limit move and keep-warm's reserve read nothing else, and the account lists publish
// the same verdict as `state`.

export type ServiceabilityDeps = Pick<Services, "accountUsage" | "claudeSeats" | "claudeStore" | "cliProxy" | "providerRefusals">;

const routed = (provider: AgentProvider): provider is keyof TranslatorAccounts => (KeyedProviderSchema.options as readonly string[]).includes(provider);

const nativeFacts = (account: OauthAccount): ServiceFacts => ({
    account: account.id,
    needsReauth: account.needsReauth,
    detail: account.detail,
    seatRefusal: account.seatRefusal,
    usage: account.usage,
});

const routedFacts = (account: TranslatorAccount): ServiceFacts => ({ account: account.name, usage: account.usage, cooling: account.cooling });

// Claude's accounts from its own store with their seat marks joined in (the store's rows carry none, which is how the
// limit move once landed on a seatless account); a routed provider's from the translator, bench included.
export const accountFactsOf = async (deps: ServiceabilityDeps, provider: AgentProvider): Promise<readonly ServiceFacts[]> => {
    if (provider === "claude") {
        const [accounts, seats, usage] = await Promise.all([deps.claudeStore.list(), deps.claudeSeats.read(), deps.accountUsage.read()]);
        return accounts.map((account) => ({ ...nativeFacts(account), seatRefusal: seats[account.id]?.reason, usage: usage[account.id] }));
    }
    return routed(provider) ? (await deps.cliProxy.accounts())[provider].map(routedFacts) : [];
};

/** Every account of a provider with its verdict, in the provider's own order. `model` scopes the plan-limit half to the pools it spends. */
export const serviceabilities = async (
    deps: ServiceabilityDeps,
    provider: AgentProvider,
    model?: ModelRef,
): Promise<readonly { readonly id: string; readonly state: AccountState }[]> => {
    const [facts, refusals] = await Promise.all([accountFactsOf(deps, provider), deps.providerRefusals.read()]);
    const states = serviceStates(facts, refusals[provider], model);
    return facts.map((entry) => ({ id: entry.account, state: states.get(entry.account) ?? { kind: "unknown" } }));
};

/** One account's verdict; `unknown` for an account the provider does not hold. */
export const serviceability = async (deps: ServiceabilityDeps, provider: AgentProvider, account: string, model?: ModelRef): Promise<AccountState> =>
    (await serviceabilities(deps, provider, model)).find((entry) => entry.id === account)?.state ?? { kind: "unknown" };

// The lists publish the verdict on rows a door or the translator already assembled, so it is judged on exactly the facts
// shown beside it. Model-less: the account's tightest gating pool.

/** A provider's own account rows, each with its `state`. */
export const withAccountStates = async (deps: Pick<Services, "providerRefusals">, provider: AgentProvider, accounts: readonly OauthAccount[]): Promise<OauthAccount[]> => {
    const states = serviceStates(accounts.map(nativeFacts), (await deps.providerRefusals.read())[provider]);
    return accounts.map((account) => ({ ...account, ...stateOf(states, account.id) }));
};

/** Every routed provider's credentials, each with its `state`. */
export const withRoutedStates = async (deps: Pick<Services, "providerRefusals">, accounts: TranslatorAccounts): Promise<TranslatorAccounts> => {
    const refusals = await deps.providerRefusals.read();
    return Object.fromEntries(
        Object.entries(accounts).map(([provider, rows]) => {
            const states = serviceStates(rows.map(routedFacts), refusals[provider]);
            return [provider, rows.map((row) => ({ ...row, ...stateOf(states, row.name) }))];
        }),
    ) as TranslatorAccounts;
};

const stateOf = (states: ReadonlyMap<string, AccountState>, account: string): { state?: AccountState } => {
    const state = states.get(account);
    return state === undefined ? {} : { state };
};
