import { sandboxRef } from "@intentic/extension-api";
import {
    type AccountUsage,
    type AgentProvider,
    KeyedProviderSchema,
    type OauthAccount,
    type ProviderRefusal,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import { watch } from "vue";
import { perProvider } from "./providerCatalog";

// Who can run a turn on each provider, as last heard from the daemon: connected accounts, translator subscriptions and
// observed refusals. Which account a conversation runs on is the daemon's record (AgentSummary.account), never resolved
// here.
// In-memory only (account ids are sandbox-scoped); lives outside useChat so any reader can import it
// without a cycle.

export const providerAccounts = sandboxRef<Record<AgentProvider, readonly OauthAccount[]>>(() => perProvider<readonly OauthAccount[]>(() => []));

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
export const translatorAccounts = sandboxRef<TranslatorAccounts>(() => noTranslatorAccounts());

// When a provider last refused a turn; the observed half of "can I run", read beside the polled rings.
export const providerRefusals = sandboxRef<Record<string, ProviderRefusal>>(() => ({}));

// Every account's headroom, keyed `${provider}:${account}`; three writers, newest `measuredAt`
// always wins.
export const usageByAccount = sandboxRef<Record<string, AccountUsage>>(() => ({}));

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
export const accountsLoaded = sandboxRef(() => false);

// Marks one account as needing a new sign-in, ahead of the next list read that will say the same: the account a failure
// frame named, never one resolved here.
export const markNeedsReauth = (provider: AgentProvider, account: string, detail: string): void => {
    const accounts = providerAccounts.value[provider] ?? [];
    const marked = accounts.map((entry: OauthAccount) =>
        entry.id === account ? Object.assign({}, entry, { needsReauth: true, detail, state: { kind: `blocked`, fix: `reconnect`, reason: detail } as const }) : entry,
    );
    providerAccounts.value = { ...providerAccounts.value, [provider]: marked };
};
