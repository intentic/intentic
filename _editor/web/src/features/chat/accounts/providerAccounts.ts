import {
    type AccountUsage,
    type AgentProvider,
    KeyedProviderSchema,
    type OauthAccount,
    type ProviderRefusal,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import { computed, ref, watch, type WritableComputedRef } from "vue";
import { type AccountPicks, accountPicks } from "./accountPreference";
import { perProvider } from "./providerCatalog";

// Who can run a turn on each provider, as last heard from the daemon: connected accounts, translator
// subscriptions, observed refusals, and the rule that resolves a conversation's next account.
// In-memory only (account ids are sandbox-scoped); lives outside useChat so any reader can import it
// without a cycle. The user's last pick is a separate, persisted preference in accountPreference.ts.

export const providerAccounts = ref<Record<AgentProvider, readonly OauthAccount[]>>(perProvider<readonly OauthAccount[]>(() => []));

// Not a ref of its own: reads and writes go straight through to the scoped sandbox's stored preference.
export const selectedAccountId: WritableComputedRef<AccountPicks> = computed({
    get: () => accountPicks().value,
    set: (picks) => {
        accountPicks().value = picks;
    },
});

// One empty slot per routed provider, built from the contract's own list; a missing slot would throw
// when a reader checks its length. The translator's subscriptions are the other half of "can this
// provider run".
export const noTranslatorAccounts = (): TranslatorAccounts => {
    const seeded: Partial<TranslatorAccounts> = {};
    for (const provider of KeyedProviderSchema.options) {
        seeded[provider] = [];
    }
    return seeded as TranslatorAccounts;
};
export const translatorAccounts = ref<TranslatorAccounts>(noTranslatorAccounts());

// When a provider last refused a turn; the observed half of "can I run", read beside the polled rings.
export const providerRefusals = ref<Record<string, ProviderRefusal>>({});

// Every account's headroom, keyed `${provider}:${account}`; three writers, newest `measuredAt`
// always wins.
export const usageByAccount = ref<Record<string, AccountUsage>>({});

// Writes or clears (`undefined`) a reading, keeping whichever is newest so a late frame can't
// overwrite a fresher one.
export const setAccountUsage = (provider: AgentProvider, account: string, usage: AccountUsage | undefined): void => {
    const key = `${provider}:${account}`;
    if (usage === undefined) {
        const { [key]: _cleared, ...rest } = usageByAccount.value;
        usageByAccount.value = rest;
        return;
    }
    if ((usageByAccount.value[key]?.measuredAt ?? 0) > usage.measuredAt) {
        return;
    }
    usageByAccount.value = { ...usageByAccount.value, [key]: usage };
};

// Looks up a reading the way a surface names the account: native by id, routed by auth-file name.
export const lookupUsage = (provider: AgentProvider, account: string): AccountUsage | undefined => usageByAccount.value[`${provider}:${account}`];

// Seeds from the rows as they land, synchronously, so a reader right after a list lands sees it at once.
watch(
    [providerAccounts, translatorAccounts],
    ([native, routed]) => {
        for (const [provider, accounts] of Object.entries(native)) {
            for (const account of accounts) {
                if (account.usage !== undefined) {
                    setAccountUsage(provider, account.id, account.usage);
                }
            }
        }
        for (const [provider, accounts] of Object.entries(routed)) {
            for (const account of accounts) {
                if (account.usage !== undefined) {
                    setAccountUsage(provider, account.name, account.usage);
                }
            }
        }
    },
    { flush: "sync" },
);

// Whether the lists have been read yet: distinguishes "no account" from "haven't asked".
export const accountsLoaded = ref(false);

// A guess at which account an unnamed turn probably runs on, for readers of account-keyed state (the
// usage map). Not authoritative: the daemon decides, and reports back on the session frame.
export const effectiveAccount = (provider: AgentProvider, picked: string | undefined): string | undefined =>
    picked ?? providerAccounts.value[provider]?.[0]?.id;

// The account a fresh turn on a provider uses: the user's explicit pick when it's still connected, else the
// provider's first connected account. The single source every account-reset site routes through.
export const rememberedAccountFor = (provider: AgentProvider): string | undefined => {
    // An unseeded provider key (an ACP agent) has no daemon account store, its own credential store serves it.
    const accounts = providerAccounts.value[provider] ?? [];
    const picked = selectedAccountId.value[provider];
    // Before the list loads, trust the persisted pick outright; once loaded, a pick it doesn't contain is
    // stale.
    if (!accountsLoaded.value) {
        return picked;
    }
    return accounts.some((account) => account.id === picked) ? picked : accounts[0]?.id;
};

// Marks the account a turn actually ran under for reauth, using the same resolution rule every
// account-keyed reader follows.
export const markAccountReauth = (provider: AgentProvider, picked: string | undefined, detail: string): void => {
    const accounts = providerAccounts.value[provider] ?? [];
    const accountId = effectiveAccount(provider, picked);
    const marked = accounts.map((account: OauthAccount) =>
        account.id === accountId ? Object.assign({}, account, { needsReauth: true, detail }) : account,
    );
    providerAccounts.value = { ...providerAccounts.value, [provider]: marked };
};
