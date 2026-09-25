import {
    type AgentProvider,
    type KeyedProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type OauthAccount,
    type PlanLimitsHeld,
    providerSpec,
    type UsageAccount,
} from "@intentic/sandbox-contract";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { errorMessage } from "@intentic/ui/async";
import { computed, watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } from "./providerAccounts";
import { endpointProviders, trialStatus } from "./providerCatalog";
import { rememberedProviderFor, turnDefaults } from "../run/turnDefaults";
import { accessKnown, firstReadyProvider, hasSignIn, providerReadyOn } from "../session/access";
import { conversations } from "../tabs/useChat-tabs";
import { loadActiveProviderModels, loadRunnableProviders, loadProviderCommands, readOrKeep } from "../models/useChat-catalog";
import { orRefusal, SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

// An unseeded provider key (an ACP agent, which owns its own credentials) simply has no account list.
export const accountsOf = (target: AgentProvider): readonly OauthAccount[] => providerAccounts.value[target] ?? [];
// The manage card's accounts, which follow the card's own provider rather than any conversation's.
export const managedAccounts = computed<readonly OauthAccount[]>(() => accountsOf(managedProvider.value));

// Providers with no native account, authenticating only through the translator's subscription. Grok
// is excluded by name: it holds both, and which one gates depends on the harness.
export const subscriptionOnly = (p: AgentProvider): p is KeyedProvider => p !== `grok` && providerSpec(p)?.auth.kind === `translator`;

// Where the card was when the last sandbox's scope ended; unset until the first switch.
let cardWas: AgentProvider | undefined;

// Provider the manage/connect card acts on; decoupled from the active conversation's own provider. Each sandbox opens
// the card on the user's remembered pick, but only where that is a provider it can connect; else it stays put.
export const managedProvider = sandboxRef<AgentProvider>(
    () => {
        const picked = turnDefaults.provider.value;
        return picked !== undefined && hasSignIn(picked) ? picked : (cardWas ?? rememberedProviderFor());
    },
    (previous) => {
        cardWas = previous;
    },
);

// Per-account token/cost totals, keyed by account id; loaded when the manage card opens.
export const accountUsage = sandboxRef<Record<string, UsageAccount>>(() => ({}));
// Whether the usage read has landed, separately from connections; surfaces hold a placeholder until
// it flips.
export const usageLoaded = sandboxRef(() => false);
// A failed read leaves it unflipped: flipped anyway, every row would read "no turns yet" about an account with history.
export const loadUsage = (): Promise<void> =>
    readOrKeep(sandboxRpc.system.usage(), (body) => {
        accountUsage.value = Object.fromEntries(body.accounts.map((usage) => [usage.account, usage]));
        usageLoaded.value = true;
    });

// Only points the card at a provider; never starts a handshake (that's startConnect/connectTranslator).
// A live handshake elsewhere is not cancelled by switching tabs.
export const setManagedProvider = (target: AgentProvider): void => {
    managedProvider.value = target;
};

// Key of the account write in flight (provider id or account id); keyed so only that row's button spins.
export const accountBusy = sandboxRef<string | undefined>(() => undefined);

export const refreshTranslatorAccounts = (): Promise<void> =>
    readOrKeep(sandboxRpc.translator.accounts(), (listing) => {
        translatorAccounts.value = listing;
    });

// When each provider last refused a turn; the observed counterpart to the polled account snapshots.
const refreshProviderRefusals = (): Promise<void> =>
    readOrKeep(sandboxRpc.agent.refusals(), (body) => {
        providerRefusals.value = body.refusals;
    });

// `error` carries connection/account errors only; per-turn chat errors live on each Conversation.
export const error = sandboxRef<string | null>(() => null);
const hasAccount = (target: AgentProvider): boolean => accountsOf(target).length > 0;
export const claudeConnected = computed(() => hasAccount(`claude`));

// Repoints fresh, unstarted conversations to a working provider once accountsLoaded confirms nothing
// can send.
watch([providerAccounts, translatorAccounts, accessKnown, endpointProviders, trialStatus], () => {
    if (!accessKnown.value) {
        return;
    }
    for (const conversation of conversations.value) {
        if (conversation.session.value !== undefined || conversation.transcript.messages.value.length > 0) {
            continue;
        }
        // Returns from an app-chosen fallback once its provider is ready again; only chats this pass moved qualify.
        if (conversation.selection.movedFrom.value !== undefined && providerReadyOn(conversation.selection.movedFrom.value.provider, conversation.selection.harness.value)) {
            conversation.selection.apply({ kind: `restoreProvider` });
            continue;
        }
        if (providerReadyOn(conversation.selection.provider.value, conversation.selection.harness.value)) {
            continue;
        }
        const fallback = firstReadyProvider();
        if (fallback) {
            // repointProvider, not selectProvider: an app-forced move says nothing about what the user wants next
            // time.
            conversation.selection.apply({ kind: `repointProvider`, provider: fallback });
        }
    }
});

// Add a freshly-connected account to its provider's list.
export const addAccount = (target: AgentProvider, added: OauthAccount): void => {
    const existing = accountsOf(target).filter((a) => a.id !== added.id);
    providerAccounts.value = { ...providerAccounts.value, [target]: [...existing, added] };
    adoptStranded(target, added);
};

// Whether a conversation has run anywhere: the daemon has it on record, or this window holds its session. A chat that
// has not can be pointed at any account, since nothing runs anywhere yet; one that has is moved only by a person.
const hasRun = (conversation: (typeof conversations.value)[number]): boolean =>
    conversation.registered.value || conversation.session.value !== undefined;

// The same person signing in again, which is the one move a reconnect may make for them: both rows say whose they are,
// and it is the same identity. An unnamed identity, or a row the list no longer holds, proves nothing.
const samePerson = (stranded: OauthAccount | undefined, added: OauthAccount): boolean =>
    stranded?.email !== undefined && stranded.email === added.email;

// A reconnect mints a new account id, so chats pinned to the old one move across. Only chats whose account is missing
// or flagged for reauth move, and a chat that has run only when the new sign-in is the same person's: connecting a
// second account while one needs reauth is not a decision to run every stranded conversation on it.
const adoptStranded = (target: AgentProvider, added: OauthAccount): void => {
    const live = accountsOf(target);
    for (const conversation of conversations.value) {
        if (conversation.selection.provider.value !== target) {
            continue;
        }
        const current = conversation.selection.account.value;
        const stranded = current !== undefined && current !== added.id && !live.some((entry) => entry.id === current && entry.needsReauth !== true);
        if (stranded && (!hasRun(conversation) || samePerson(live.find((entry) => entry.id === current), added))) {
            conversation.selection.apply({ kind: `rebindAccount`, account: added.id });
        }
        void conversation.turn.resume();
    }
};

// adoptStranded's mirror, for chats that have not run: pinned to an account the list no longer has, they go back to
// auto, for the daemon to place by serviceability. No "switched to…" divider: nothing ran on the pick. A chat that has
// run keeps its pin: which account it goes on is its person's call, and its next turn is refused saying so rather than
// landing on whichever account happens to be left (harness-credentials.ts).
const repointStranded = (target: AgentProvider, live: readonly OauthAccount[]): void => {
    // An empty list is not a verdict on anyone's pick: a read that came back with nothing leaves every pin alone.
    if (live.length === 0) {
        return;
    }
    for (const conversation of conversations.value) {
        const pin = conversation.selection.account.value;
        if (conversation.selection.provider.value === target && pin !== undefined && !live.some((entry) => entry.id === pin) && !hasRun(conversation)) {
            conversation.selection.apply({ kind: `set`, picks: { account: undefined } });
        }
    }
};

// Pulls a provider's account list and keeps the selection valid; the single reader of `accounts.accounts`. Throws on
// failure, since a daemon that didn't answer is not the same as an empty account list.
// Never asks the daemon to re-measure: a forced read is one sweep across every provider (readConnections), not
// one per list. The account routes name a native provider; any other id is the daemon's to refuse.
export const refreshAccounts = async (target: AgentProvider): Promise<OauthAccount[]> => {
    const current = sandboxScopeGuard();
    const list = (await sandboxRpc.accounts.accounts({ provider: target as NativeProvider })).accounts;
    // Another sandbox's accounts: this one's list is its own read's to fill.
    if (!current()) {
        return list;
    }
    // Seeds the shared usage map as this list lands, so headroom shows immediately, not after the next turn.
    providerAccounts.value = { ...providerAccounts.value, [target]: list };
    // The remembered pick is never rewritten from a list; every reader resolves it against the live list already.
    repointStranded(target, list);
    return list;
};

// Accounts a provider is rate-limiting, from the last forced re-measure: which readings could not move, and when
// they can. Empty after a press that read everything, so a surface can state either outcome.
export const heldAccounts = sandboxRef<readonly PlanLimitsHeld[]>(() => []);

// Reads every connection (accounts and translator subscriptions) as one call, since to a user they're
// one question. `accountsLoaded` flips only once a real read lands; the translator read is excluded
// since it swallows its own failure.
// Asks the daemon to re-measure and says what it could not read. Forced, it measures even a reading taken a moment ago
// and is worth waiting for; unforced it is the same question a screen asks on arrival, and answers from the sweep
// already due. Held accounts come back either way: a number that cannot move must not need a press to explain itself.
const readPlanLimits = async (force: boolean): Promise<void> => {
    const current = sandboxScopeGuard();
    const refreshed = await sandboxRpc.usage.refreshPlanLimits({ force }).catch(() => undefined);
    // Only on an answer: a daemon that didn't reply hasn't withdrawn the accounts it last said were held.
    if (refreshed !== undefined && current()) {
        heldAccounts.value = refreshed.held;
    }
};

const readConnections = async (force: boolean): Promise<void> => {
    const current = sandboxScopeGuard();
    // Forced: one route re-measures every connection first, past the freshness bound a background sweep is held to.
    if (force) {
        // A press that lands on a rate-limited account changes no number, so what it could not read is kept and said.
        await readPlanLimits(true);
    }
    const natives = NATIVE_PROVIDERS.filter((target) => !subscriptionOnly(target));
    // Started with the lists and awaited after the gate: unforced it holds for the daemon's sweep, and its own answer
    // lands on `heldAccounts` whenever it arrives.
    const limits = force ? undefined : readPlanLimits(false);
    const runnable = loadRunnableProviders();
    const [reads] = await Promise.all([
        Promise.allSettled(natives.map((target) => refreshAccounts(target))),
        refreshTranslatorAccounts(),
        refreshProviderRefusals(),
        // The daemon's own readiness rides with the account lists rather than only with the catalogs: the two answer
        // one question, and a disconnect that moved one and not the other would leave a gone account reading ready.
        runnable.ready,
    ]);
    if (reads.some((read) => read.status === `fulfilled`) && current()) {
        accountsLoaded.value = true;
    }
    // Endpoint catalogs and the trial allowance are `endpointsLoaded`'s to wait on, not this gate's.
    await Promise.all([runnable.settled, limits]);
};

// The unforced read in flight, joined by concurrent mounters; a forced read is never joined, and neither is the
// outgoing sandbox's.
const connectionsInFlight = sandboxValue<Promise<void> | undefined>(() => undefined);

export const refreshConnections = (force = false): Promise<void> => {
    if (force) {
        return readConnections(true);
    }
    const current = sandboxScopeGuard();
    connectionsInFlight.value ??= readConnections(false).finally(() => {
        if (current()) {
            connectionsInFlight.value = undefined;
        }
    });
    return connectionsInFlight.value;
};

// Everything daemon-owned the chat needs, read on the reachable seam. Exported for sandboxScope,
// which re-runs it whenever the active daemon becomes reachable.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        // Which accounts and subscriptions this sandbox is signed in with, the gate every provider surface reads.
        // Carries the runnable list (ACP agents, endpoints, native readiness) with it: one question, one read.
        refreshConnections(),
        // Model lists are daemon-owned too; the open chat's loads on the same reachable seam, so its composer can name
        // the model it will send on. The other providers' lists are the picker's to fetch when it opens.
        loadActiveProviderModels(),
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
// THROWS rather than posting to `error`: the row that asked is holding an open field, and a sentence beside that
// field beats a notice at the top of the section, over a list where every row looks alike.
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
    let renamed: OauthAccount | SandboxHttpError;
    try {
        renamed = await orRefusal(sandboxRpc.accounts.rename({ provider: target as NativeProvider, id, label: typed }));
    } catch (unanswered) {
        replaceAccount(target, current);
        throw new Error(`Couldn't reach your sandbox to rename that account.`, { cause: unanswered });
    }
    if (renamed instanceof SandboxHttpError) {
        // A 404 means the row is gone elsewhere; re-read rather than restore a name onto a dead account.
        if (renamed.status === 404) {
            await refreshAccounts(target).catch(() => replaceAccount(target, current));
            throw new Error(`That account is no longer connected.`);
        }
        replaceAccount(target, current);
        throw new Error(`Couldn't rename that account: ${renamed.message}`, { cause: renamed });
    }
    replaceAccount(target, renamed);
};

// Disconnect one account of the managed provider by id; drop it from the list and fix the selection. Busy for
// the round-trip, like every other account write, the row's own button says so. A refused disconnect keeps the row: the
// account is still signed in, and a list without it would say otherwise.
export const disconnect = async (id: string): Promise<void> => {
    const target = managedProvider.value;
    accountBusy.value = target;
    error.value = null;
    const current = sandboxScopeGuard();
    try {
        await sandboxRpc.accounts.disconnect({ provider: target as NativeProvider, id });
    } catch (caught) {
        if (current()) {
            error.value = errorMessage(caught, `Couldn't disconnect that account.`);
        }
        return;
    } finally {
        if (current()) {
            accountBusy.value = undefined;
        }
    }
    // The account was the box left behind's: this box's list and picks never held it.
    if (!current()) {
        return;
    }
    const remaining = accountsOf(target).filter((entry) => entry.id !== id);
    providerAccounts.value = { ...providerAccounts.value, [target]: remaining };
    // The chats that were running on it move on too, rather than holding an id nothing can serve.
    repointStranded(target, remaining);
};

// A singleton per window; a hot update re-running this module would mint a second account record.
reloadOnHotUpdate(import.meta);
