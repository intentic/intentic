import { sandboxRef, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import type { AccountUsage, ProviderRefusal, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { CapacitySnapshot, ProviderCapacity } from "@intentic/sandbox-contract/schemas/providers/capacity";
import { watch } from "vue";
import { perProvider } from "./providerCatalog";
import type { SwitchOffs } from "@intentic/sandbox-contract/models/plan-pools";

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

// Every refusal the daemon holds on file, per provider, as it holds them: the observed half of "can I run", which every
// verdict here judges by beside the polled rings (usageStatus.ts accountState), exactly as the daemon's own does.
export const providerRefusals = sandboxRef<Record<string, readonly ProviderRefusal[]>>(() => ({}));

// Each provider's accounts' switch-offs this week, as the daemon publishes them beside the refusals: the facts a pick
// ranks a flapping account by (plan-pools.ts flappingAccounts), read here so a window places a turn as the daemon does.
export const providerSwitchOffs = sandboxRef<Readonly<Record<string, SwitchOffs>>>(() => ({}));

// One provider's refusals as they now stand, and its switch-offs with them; switch-offs a daemon that predates them
// leaves out keep what this window held.
export const setProviderRefusals = (provider: string, refusals: readonly ProviderRefusal[], switchOffs: SwitchOffs | undefined): void => {
    providerRefusals.value = { ...providerRefusals.value, [provider]: refusals };
    // compat(daemon<1.419.1): the refusals' `switchOffs`
    if (switchOffs !== undefined) {
        providerSwitchOffs.value = { ...providerSwitchOffs.value, [provider]: switchOffs };
    }
};

/* EACH PROVIDER'S CAPACITY AS THE DAEMON LAST JUDGED IT (schemas/providers/capacity.ts): every account with the facts the
   serviceability rule read, the refusals and switch-offs on file, where a turn naming no account would run, and whether
   the provider itself is failing. Before 2026-11-19 a window assembled that picture from the four stores above, which
   arrive apart, and judged it on its own clock. A daemon that judges it sends it on `/events` (`capacity`, asked for when
   the stream opens) and answers it whole on `usage.capacity`; the verdict door (usageStatus.ts) reads a provider from here
   whenever it holds one, and from the four stores above against a daemon from before it, which never fills this. */
export const providerCapacities = sandboxShallowRef<Readonly<Record<string, ProviderCapacity>>>(() => ({}));

// Providers whose held capacity came over a connection that has since ended. `seq` counts from the daemon's start, so a
// restarted daemon's first capacity is numbered below the last one the old process sent: the next one heard for each of
// these replaces it whatever its number, as a new connection's roster revision does (useAgents.ts desyncAgents).
const carriedOver = sandboxValue<Set<string>>(() => new Set());

// Whether `next` replaces what is held for its provider: anything once a connection has ended, else only a higher `seq`,
// so a frame and a read of the whole picture racing each other cannot leave the older of the two standing.
const supersedes = (next: ProviderCapacity): boolean => {
    const held = providerCapacities.value[next.provider];
    return held === undefined || carriedOver.value.has(next.provider) || next.seq > held.seq;
};

/** Holds one provider's capacity as a frame carried it, unless a later one is already held. */
export const setProviderCapacity = (capacity: ProviderCapacity): void => {
    if (!supersedes(capacity)) {
        return;
    }
    carriedOver.value.delete(capacity.provider);
    providerCapacities.value = { ...providerCapacities.value, [capacity.provider]: capacity };
};

/**
 * Holds every provider's capacity as `usage.capacity` answered it. A provider the answer leaves out has nothing connected
 * and nothing on file any more, so what was held for it goes, unless a frame newer than the whole answer replaced it.
 */
export const setCapacitySnapshot = (snapshot: CapacitySnapshot): void => {
    const oldest = snapshot.providers.reduce((least, capacity) => Math.min(least, capacity.seq), Number.POSITIVE_INFINITY);
    const kept = Object.fromEntries(
        Object.entries(providerCapacities.value).filter(([provider, held]) => !carriedOver.value.has(provider) && held.seq > oldest),
    );
    const next = { ...kept };
    for (const capacity of snapshot.providers) {
        const held = kept[capacity.provider];
        if (held === undefined || capacity.seq > held.seq) {
            next[capacity.provider] = capacity;
        }
    }
    carriedOver.value = new Set();
    providerCapacities.value = next;
};

/**
 * A new `/events` connection: what is held stays drawn until the daemon's first capacity for each provider replaces it.
 * Against a daemon that does not judge capacity (an older one, after a rollback) nothing held is kept, and every surface
 * reads the four stores above again.
 */
export const capacityReconnected = (judged: boolean): void => {
    if (!judged) {
        carriedOver.value = new Set();
        providerCapacities.value = {};
        return;
    }
    carriedOver.value = new Set(Object.keys(providerCapacities.value));
};

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
        entry.id === account ? Object.assign({}, entry, { needsReauth: true, detail }) : entry,
    );
    providerAccounts.value = { ...providerAccounts.value, [provider]: marked };
};
