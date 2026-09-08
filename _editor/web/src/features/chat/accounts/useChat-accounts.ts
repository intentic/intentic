import { errorMessage } from "@intentic/ui/async";
import {
    type AgentProvider,
    type KeyedProvider,
    NATIVE_PROVIDERS,
    type OauthAccount,
    type ProviderRefusals,
    providerSpec,
    TRIAL_PROVIDER,
    type TranslatorAccounts,
    type UsageAccount,
} from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { accountsLoaded, providerAccounts, providerRefusals, selectedAccountId, translatorAccounts } from "./providerAccounts";
import { endpointProviders, trialStatus } from "./providerCatalog";
import { turnDefaults } from "../run/turnDefaults";
import { accessKnown, providerReady, providerReadyOn } from "../session/access";
import { conversations } from "../tabs/useChat-tabs";
import { loadAllProviderModels, loadCapabilityProviders, loadProviderCommands, readOrKeep } from "../models/useChat-catalog";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";

// An unseeded provider key (an ACP agent, which owns its own credentials) simply has no account list.
export const accountsOf = (target: AgentProvider): readonly OauthAccount[] => providerAccounts.value[target] ?? [];
// The manage card's accounts, which follow the card's own provider rather than any conversation's.
export const managedAccounts = computed<readonly OauthAccount[]>(() => accountsOf(managedProvider.value));

/* Where a provider's ACCOUNT rows live: one route family with the provider in the path (accounts.contract.ts),
 * which is what lets one set of helpers read, rename, disconnect and connect an account without knowing whose
 * it is. A provider whose only credential is the translator's subscription has no door there (subscriptionOnly
 * keeps those out of refreshConnections); catalogs are not here either, they come off /providers.
 *
 * ENCODED, because a provider id is an open vocabulary and some of them carry a slash (`endpoint/free-trial`).
 * Interpolated raw, that id put an extra SEGMENT in the path, and `{provider}` matches exactly one, so the
 * request walked off `/accounts/{provider}/login/start` and matched no route at all: a bare 404 with nothing in
 * the body, reported as "Request failed (404)" because there was no daemon sentence to quote. Encoded, a call
 * for a provider these routes do not serve lands ON the route and is refused in the daemon's own words. */
export const providerBase = (p: AgentProvider): string => `/accounts/${encodeURIComponent(p)}`;

// Providers with no native account, authenticating only through the translator's subscription. Grok
// is excluded by name: it holds both, and which one gates depends on the harness.
export const subscriptionOnly = (p: AgentProvider): p is KeyedProvider => p !== `grok` && providerSpec(p)?.auth.kind === `translator`;

// Provider the manage/connect card acts on; decoupled from the active conversation's own provider.
export const managedProvider = ref<AgentProvider>(turnDefaults.provider.value);

// Per-account token/cost totals, keyed by account id; loaded when the manage card opens.
export const accountUsage = ref<Record<string, UsageAccount>>({});
// Whether the usage read has landed, separately from connections; surfaces hold a placeholder until
// it flips.
export const usageLoaded = ref(false);
export const loadUsage = async (): Promise<void> => {
    await readOrKeep<{ accounts: UsageAccount[] }>(`/system/usage`, (body) => {
        accountUsage.value = Object.fromEntries(body.accounts.map((usage) => [usage.account, usage]));
    });
    usageLoaded.value = true;
};

// Only points the card at a provider; never starts a handshake (that's startConnect/connectTranslator).
// A live handshake elsewhere is not cancelled by switching tabs.
export const setManagedProvider = (target: AgentProvider): void => {
    managedProvider.value = target;
};

// Key of the account write in flight (provider id or account id); keyed so only that row's button spins.
export const accountBusy = ref<string | undefined>(undefined);

export const refreshTranslatorAccounts = (): Promise<void> =>
    readOrKeep<TranslatorAccounts>(`/translator/accounts`, (listing) => {
        translatorAccounts.value = listing;
    });

// When each provider last refused a turn; the observed counterpart to the polled account snapshots.
const refreshProviderRefusals = (): Promise<void> =>
    readOrKeep<ProviderRefusals>(`/agent/refusals`, (body) => {
        providerRefusals.value = body.refusals;
    });

// `error` carries connection/account errors only; per-turn chat errors live on each Conversation.
export const error = ref<string | null>(null);
const hasAccount = (target: AgentProvider): boolean => accountsOf(target).length > 0;
export const claudeConnected = computed(() => hasAccount(`claude`));

// Repoints fresh, unstarted conversations to a working provider once accountsLoaded confirms nothing
// can send.
watch([providerAccounts, translatorAccounts, accessKnown, endpointProviders, trialStatus], () => {
    if (!accessKnown.value) {
        return;
    }
    for (const conversation of conversations.value) {
        if (conversation.session.value !== undefined || conversation.messages.value.length > 0) {
            continue;
        }
        // Returns from an app-chosen fallback once its provider is ready again; only chats this pass moved qualify.
        if (conversation.movedFrom.value !== undefined && providerReadyOn(conversation.movedFrom.value.provider, conversation.harness.value)) {
            conversation.restoreProvider();
            continue;
        }
        if (providerReadyOn(conversation.provider.value, conversation.harness.value)) {
            continue;
        }
        // A connected account first; the trial is only a floor under nothing connected, never a subscription
        // fallback.
        const fallback = NATIVE_PROVIDERS.find((p) => providerReady(p)) ?? (providerReady(TRIAL_PROVIDER) ? TRIAL_PROVIDER : undefined);
        if (fallback) {
            // repointProvider, not selectProvider: an app-forced move says nothing about what the user wants next
            // time.
            conversation.repointProvider(fallback);
        }
    }
});

// Add a freshly-connected account to its provider's list and make it the selected one.
export const addAccount = (target: AgentProvider, added: OauthAccount): void => {
    const existing = accountsOf(target).filter((a) => a.id !== added.id);
    providerAccounts.value = { ...providerAccounts.value, [target]: [...existing, added] };
    selectedAccountId.value = { ...selectedAccountId.value, [target]: added.id };
    adoptStranded(target, added);
};

// A reconnect mints a new account id, so chats pinned to the old one move across. Only chats whose
// account is missing or flagged for reauth move; a second healthy account never redirects others.
const adoptStranded = (target: AgentProvider, added: OauthAccount): void => {
    const live = accountsOf(target);
    for (const conversation of conversations.value) {
        if (conversation.provider.value !== target) {
            continue;
        }
        const current = conversation.account.value;
        if (current !== undefined && current !== added.id && !live.some((entry) => entry.id === current && entry.needsReauth !== true)) {
            conversation.rebindAccount(added.id);
        }
        void conversation.resume();
    }
};

// adoptStranded's mirror: conversations pinned to an account the list no longer has move onto the
// live pick. Rebound, not selected, so no "switched to…" divider is raised; nothing to move to leaves
// the pin alone.
const repointStranded = (target: AgentProvider, live: readonly OauthAccount[]): void => {
    const picked = selectedAccountId.value[target];
    // Resolved against this list directly, not rememberedAccountFor, which leaves the pick unvalidated longer.
    const next = live.some((entry) => entry.id === picked) ? picked : live[0]?.id;
    if (next === undefined) {
        return;
    }
    for (const conversation of conversations.value) {
        const pin = conversation.account.value;
        if (conversation.provider.value === target && pin !== undefined && !live.some((entry) => entry.id === pin)) {
            conversation.rebindAccount(next);
        }
    }
};

// Pulls a provider's account list and keeps the selection valid; the single reader of the `/accounts`
// routes. Throws on failure, since a daemon that didn't answer is not the same as an empty account list.
export const refreshAccounts = async (target: AgentProvider, force: boolean): Promise<OauthAccount[]> => {
    // `force` re-measures before answering, Claude only; routed rings come from a non-blocking background
    // sweep.
    const forced = force && target === `claude` ? `?force=1` : ``;
    const list = (await sandboxJson<{ accounts?: OauthAccount[] }>(`${providerBase(target)}${forced}`)).accounts ?? [];
    // Seeds the shared usage map as this list lands, so headroom shows immediately, not after the next turn.
    providerAccounts.value = { ...providerAccounts.value, [target]: list };
    // The remembered pick is never rewritten from a list; every reader resolves it against the live list already.
    repointStranded(target, list);
    return list;
};

// Reads every connection (accounts and translator subscriptions) as one call, since to a user they're
// one question. `accountsLoaded` flips only once a real read lands; the translator read is excluded
// since it swallows its own failure.
const readConnections = async (force: boolean): Promise<void> => {
    // Forced: one route re-measures every connection first, bypassing the daemon's usual minute-long cache.
    if (force) {
        await sandboxJson(`/usage/plan-limits/refresh`, jsonBody(`POST`, { force: true })).catch(() => undefined);
    }
    const natives = NATIVE_PROVIDERS.filter((target) => !subscriptionOnly(target));
    const [reads] = await Promise.all([
        Promise.allSettled(natives.map((target) => refreshAccounts(target, false))),
        refreshTranslatorAccounts(),
        refreshProviderRefusals(),
    ]);
    if (reads.some((read) => read.status === `fulfilled`)) {
        accountsLoaded.value = true;
    }
};

// The unforced read in flight, joined by concurrent mounters; a forced read is never joined.
let connectionsInFlight: Promise<void> | undefined;

export const refreshConnections = (force = false): Promise<void> => {
    if (force) {
        return readConnections(true);
    }
    connectionsInFlight ??= readConnections(false).finally(() => {
        connectionsInFlight = undefined;
    });
    return connectionsInFlight;
};

// Everything daemon-owned the chat needs, read on the reachable seam. Exported for sandboxScope,
// which re-runs it whenever the active daemon becomes reachable.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        // Which accounts and subscriptions this sandbox is signed in with, the gate every provider surface reads.
        refreshConnections(),
        // Model lists are daemon-owned too, load them on the same reachable seam so the pickers are ready.
        loadAllProviderModels(),
        // Installed ACP agents and model endpoints are providers too, surface them on the same seam.
        loadCapabilityProviders(),
        // Claude only, for a populated `/` popover on open; other providers load via ensureProviderCommands.
        loadProviderCommands(`claude`),
    ]);
};

// Swaps one account in place, leaving order and selection alone; unlike addAccount, which appends and
// selects.
const replaceAccount = (target: AgentProvider, next: OauthAccount): void => {
    providerAccounts.value = {
        ...providerAccounts.value,
        [target]: accountsOf(target).map((entry) => (entry.id === next.id ? next : entry)),
    };
};

// Renames the display name only, applied optimistically then reconciled against the daemon's answer
// on response. Doesn't use `accountBusy`, which gates Disconnect/startConnect, not renames.
export const renameAccount = async (id: string, label: string): Promise<void> => {
    const target = managedProvider.value;
    const typed = label.trim();
    const current = accountsOf(target).find((entry) => entry.id === id);
    if (current === undefined) {
        return;
    }
    if (typed !== ``) {
        replaceAccount(target, { ...current, label: typed });
    }
    let response: Response;
    try {
        response = await sandboxRequest(`${providerBase(target)}/rename`, jsonBody(`POST`, { id, label: typed }));
    } catch (err) {
        error.value = errorMessage(err, `Could not rename that account: is your sandbox online?`);
        replaceAccount(target, current);
        return;
    }
    if (!response.ok) {
        // A 404 means the row is gone elsewhere; re-read rather than restore a name onto a dead account.
        error.value = response.status === 404 ? `That account is no longer connected.` : `Could not rename that account.`;
        await refreshAccounts(target, false).catch(() => replaceAccount(target, current));
        return;
    }
    replaceAccount(target, (await response.json()) as OauthAccount);
    error.value = null;
};

// Disconnect one account of the managed provider by id; drop it from the list and fix the selection. Busy for
// the round-trip, like every other account write, the row's own button says so.
export const disconnect = async (id: string): Promise<void> => {
    const target = managedProvider.value;
    accountBusy.value = target;
    await sandboxRequest(`${providerBase(target)}/disconnect`, jsonBody(`POST`, { id }))
        .catch(() => undefined)
        .finally(() => (accountBusy.value = undefined));
    const remaining = accountsOf(target).filter((entry) => entry.id !== id);
    providerAccounts.value = { ...providerAccounts.value, [target]: remaining };
    if (selectedAccountId.value[target] === id) {
        selectedAccountId.value = { ...selectedAccountId.value, [target]: remaining[0]?.id };
    }
    // The chats that were running on it move on too, rather than holding an id nothing can serve.
    repointStranded(target, remaining);
};

// A singleton per window; a hot update re-running this module would mint a second account record.
reloadOnHotUpdate(import.meta);
