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

// Providers are an open string vocabulary, an unseeded key (an ACP agent, which owns its own credentials)
// simply has no daemon account list.
export const accountsOf = (target: AgentProvider): readonly OauthAccount[] => providerAccounts.value[target] ?? [];
// The manage card's accounts, which follow the card's own provider rather than any conversation's.
export const managedAccounts = computed<readonly OauthAccount[]>(() => accountsOf(managedProvider.value));

/* Where a provider's ACCOUNT rows live: one route family with the provider in the path (accounts.contract.ts),
 * which is what lets one set of helpers read, rename, disconnect and connect an account without knowing whose
 * it is. A provider whose only credential is the translator's subscription has no door there (subscriptionOnly
 * keeps those out of refreshConnections); catalogs are not here either, they come off /providers. */
export const providerBase = (p: AgentProvider): string => `/accounts/${p}`;

/* Providers whose ONLY credential is the translator subscription: they have no native account handshake, so the
 * card shows the routed row alone and there is nothing for `startConnect` to arm. Their turns authenticate
 * through a subscription the bundled translator holds, which is why they have no row in an account picker:
 * CLIProxyAPI balances across every auth file it has, so WHICH one serves a turn is not a choice anyone makes.
 *
 * Read off the spec's auth mechanism, with Grok subtracted by name because it is the one provider holding BOTH
 * (a native xAI account and a routed subscription), and which one gates depends on the harness. */
export const subscriptionOnly = (p: AgentProvider): p is KeyedProvider => p !== `grok` && providerSpec(p)?.auth.kind === `translator`;

// Which account the manage/connect card acts on, decoupled from the chat-turn provider so connecting or
// disconnecting one account never mutates the active conversation's provider.
export const managedProvider = ref<AgentProvider>(turnDefaults.provider.value);

// Per-account token/cost totals (from the daemon's /system/usage aggregation of the activity log), keyed by
// account id. Loaded when the manage card opens; empty until then.
export const accountUsage = ref<Record<string, UsageAccount>>({});
/* Whether the usage read has come back at all. It is a SEPARATE read from the connections one and lands after
 * it, so a row knows its account's name a round trip before it knows its turns, and a line that appears under
 * a name already on screen shoves every row below it down. Surfaces hold a placeholder in that line's place
 * until this flips, which is the difference between a list settling and a list twitching. Set even when the
 * read fails: an outline that never resolves is worse than a row with no usage line. */
export const usageLoaded = ref(false);
export const loadUsage = async (): Promise<void> => {
    await readOrKeep<{ accounts: UsageAccount[] }>(`/system/usage`, (body) => {
        accountUsage.value = Object.fromEntries(body.accounts.map((usage) => [usage.account, usage]));
    });
    usageLoaded.value = true;
};

/* Point the account card at a provider. That is ALL it does, and the emptiness is the point.
 *
 * It used to fire a connect handshake by itself whenever the card landed on an account-less native provider,
 * which is what made the switcher flicker: the row painted its "Connect" button, the /oauth/start round-trip
 * landed a moment later, and the button was yanked out from under the pointer and replaced by a device code
 * nobody had asked for. It also meant merely LOOKING at a provider minted a one-time code and started a
 * 15-minute poll, and it did so for three of the five tabs, the two that authenticate through the translator
 * never armed anything, so the same click did two different things depending on which chip it hit.
 *
 * Browsing is browsing: every provider now shows its state and waits to be asked (startConnect /
 * connectTranslator, from the row's own button). A live handshake is deliberately NOT cancelled here either,
 * both flows carry the provider they belong to, so a sign-in the user is completing at x.ai survives a look at
 * another tab instead of being silently killed by it. */
export const setManagedProvider = (target: AgentProvider): void => {
    managedProvider.value = target;
};

/* The account write in flight right now, as the KEY of the thing being written: the provider id while a sign-in
 * is being started or finished, the account id / auth-file name while one is being dropped. One ref for both
 * mechanisms (native handshake and translator subscription alike), because it exists to answer one question the
 * card asks in one place: does THIS row's button spin?
 *
 * Keyed rather than boolean so the answer is that row's and not the whole card's, a click is acknowledged in
 * the button the user pressed, at the moment they press it, instead of by something appearing elsewhere a
 * round-trip later. Its other half is serialization: one account write at a time, which is the honest reading
 * of a card that shows one provider at a time. */
export const accountBusy = ref<string | undefined>(undefined);

export const refreshTranslatorAccounts = (): Promise<void> =>
    readOrKeep<TranslatorAccounts>(`/translator/accounts`, (listing) => {
        translatorAccounts.value = listing;
    });

// When each provider last refused a turn, the observed counterpart to the polled snapshots that ride the two
// account listings (see providerRefusals).
const refreshProviderRefusals = (): Promise<void> =>
    readOrKeep<ProviderRefusals>(`/agent/refusals`, (body) => {
        providerRefusals.value = body.refusals;
    });

// Account / connection (global; the sandbox or translator owns each provider's credentials). Several accounts per provider
// live in `providerAccounts` (conversation.ts module state). `error` carries connection / account errors,
// per-turn chat errors live on each Conversation. `connected` = the ACTIVE conversation's selection can send;
// `claudeConnected` = Claude specifically (the Sandbox page's card).
export const error = ref<string | null>(null);
const hasAccount = (target: AgentProvider): boolean => accountsOf(target).length > 0;
export const claudeConnected = computed(() => hasAccount(`claude`));

/* Keep the composer usable whenever ANY provider has an account: when the connection state changes (initial
 * load, a connect/disconnect, a sandbox reset), point each untouched fresh conversation whose selection can't
 * send at a connected provider. Started conversations (a session or visible messages) are never auto-repointed,
 * that would retire their session and insert a switch notice the user didn't ask for.
 *
 * IT WAITS FOR THE WHOLE CONNECTION PICTURE (accountsLoaded), and that guard is the point of this watch, not a
 * detail of it. The two halves land INDEPENDENTLY, the translator's subscriptions come back off a local read
 * while a provider's own accounts take a round-trip, so every load passes through a moment that reads as
 * "ChatGPT connected, Claude not", which is not a fact about the user, it is a fact about which read finished
 * first. Acting on it moved a Claude user's chat to Codex a beat before their Claude account arrived, and
 * nothing moved it back: by then the chat sat on a provider that could send, so this watch had no reason to
 * touch it again. `accountsLoaded` flips only once every read has settled, which is exactly the first moment an
 * empty list means "you have nothing connected" rather than "we haven't heard yet", the same distinction
 * rememberedAccountFor draws for the account pick, for the same reason. It is a SOURCE as well as a guard so
 * the pass runs again on the completed picture rather than being lost with the partial one.
 *
 * THE TRIAL IS PART OF THAT PICTURE and lands on its own seam (loadCapabilityProviders, which discovers the
 * endpoint and then reads the allowance), so it is a source too AND half of the guard (accessKnown). Without
 * that a sandbox whose accounts settled before the trial arrived would sit on a dead provider with a perfectly
 * good free channel on its way, which is the first screen this whole pass exists to get right. */
watch([providerAccounts, translatorAccounts, accessKnown, endpointProviders, trialStatus], () => {
    if (!accessKnown.value) {
        return;
    }
    for (const conversation of conversations.value) {
        if (conversation.session.value !== undefined || conversation.messages.value.length > 0) {
            continue;
        }
        /* RETURN FROM AN APP-CHOSEN FALLBACK once the provider it was moved off can run again. The current
         * provider being ready is not enough to stop here: the free trial is ready by design, and an OAuth
         * redirect restores an untouched tab on that trial while the Google account it was signing into lands
         * separately. Treating "the trial can answer" as final silently spends the metered trial after Google
         * connected.
         *
         * ASKED OF THE CONVERSATION, NEVER OF THE GLOBAL PREFERENCE. This used to compare each conversation's
         * provider against turnDefaults.provider (the last pick made in any tab) and move anything that
         * differed, which cannot tell a fallback from a choice: a board of unsent drafts, each prepared on its
         * own model, was dragged wholesale onto whichever model had been picked most recently — on every
         * account refresh, and again on every reload. `movedFrom` is set only by repointProvider below, so the
         * only chat that returns is one this pass itself moved, and it returns to its own provider. */
        if (conversation.movedFrom.value !== undefined && providerReadyOn(conversation.movedFrom.value.provider, conversation.harness.value)) {
            conversation.restoreProvider();
            continue;
        }
        if (providerReadyOn(conversation.provider.value, conversation.harness.value)) {
            continue;
        }
        /* A connected account first, the free trial only when there is none, the trial is a metered courtesy
         * that runs through intentic's servers, so it is the floor under a sandbox with nothing connected and
         * never a thing to move somebody onto who already owns a subscription. */
        const fallback = NATIVE_PROVIDERS.find((p) => providerReady(p)) ?? (providerReady(TRIAL_PROVIDER) ? TRIAL_PROVIDER : undefined);
        if (fallback) {
            // repointProvider, not selectProvider: this chat is being moved because its provider cannot serve
            // it, which says nothing about what the user wants NEXT time. Writing it back as the remembered
            // provider is what made a single unlucky load permanent.
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

/* A reconnect mints a NEW account id, which leaves every chat still pinned to the old one sending against a
 * credential that no longer exists, measured in the incident this all comes from: a session kept failing for
 * a full minute AFTER the account was reconnected, purely because its tab held the dead id. Reconnecting means
 * "carry on", so the stranded chats move across and anything held for the outage goes now.
 *
 * Only chats whose account is missing or flagged for reauth move: adding a SECOND account alongside a healthy
 * one must not quietly redirect conversations away from the account the user chose for them. */
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

/* adoptStranded's mirror image: conversations pinned to an account the provider's list no longer HAS, moved onto
 * the live pick. Two ways to get there, the account was disconnected in this window, or it was disconnected
 * while this window was away and the pin came back from the tab snapshot, and the same outcome either way: an
 * invisible dead pin, every turn on that chat failing with "No Claude account connected", naming a fix the user
 * has already done for an account that IS connected, because the dead id is the one thing the message can't
 * mention. `live` is the provider's current list; the pick it belongs with must already be reconciled against it.
 *
 * Rebound, not selected: the user didn't switch, their choice went away, so the session moves across with the
 * conversation and no "switched to…" divider is raised. Nothing to move to (the provider has no accounts left)
 * leaves the pin alone: the composer's connect gate is what has something to say then, not the account axis. */
const repointStranded = (target: AgentProvider, live: readonly OauthAccount[]): void => {
    const picked = selectedAccountId.value[target];
    // Where a stranded chat lands: the remembered pick when the list that just arrived still holds it, else the
    // provider's first account. Resolved against THAT list rather than through rememberedAccountFor, which
    // deliberately returns the pick unvalidated until every provider's first read has landed, moving a chat
    // onto an id this very list says is gone is the failure this function exists to prevent.
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

// Pull a provider's account list from its daemon and keep the selection valid (first account when the current
// pick is gone). The single reader of the `/accounts` routes. THROWS when the read fails (sandboxJson): a
// daemon that didn't answer has not told us the user has no accounts, and callers that treat the two the same
// are how an empty card comes to claim "not connected" during an outage.
export const refreshAccounts = async (target: AgentProvider, force: boolean): Promise<OauthAccount[]> => {
    /* `force` re-measures the plan limits before the list answers, and reaches CLAUDE ALONE because it is the
     * only list that waits on a quota sweep at all. The routed subscriptions' rings come off the daemon's own
     * background sweep and that read deliberately never blocks on upstream, it is the routed turn's credential
     * gate as much as it is a settings list, so a round-trip there would land on every routed turn's startup. */
    const forced = force && target === `claude` ? `?force=1` : ``;
    const list = (await sandboxJson<{ accounts?: OauthAccount[] }>(`${providerBase(target)}${forced}`)).accounts ?? [];
    // The shared usage map is seeded from this list as it lands (providerAccounts.usageByAccount), so a fresh
    // page load shows each account's headroom immediately instead of staying blank until its next turn.
    providerAccounts.value = { ...providerAccounts.value, [target]: list };
    /* THE REMEMBERED PICK IS NOT REWRITTEN FROM A LIST. It used to be, a pick this answer didn't contain was
     * replaced by `list[0]`, and the watch above then PERSISTED that. Which made every list a verdict on the
     * user's choice, including the ones that are not: a 200 carrying an empty array is what a daemon serves
     * while its credential store is still coming up (the dir read fails soft, by design), and one of those was
     * enough to forget a deliberate choice for good, from then on every new session opened on the first
     * account, with nothing left anywhere to say otherwise. That is the "the account randomly switches back"
     * report.
     *
     * A stale pick costs nothing, because forgetting was never what made the app correct: every reader already
     * resolves it against the live list (rememberedAccountFor for a new conversation, repointStranded for the
     * open ones), so an id that is genuinely gone is stepped over on the way to the first account and a pick
     * that is merely unreadable this second survives to be honoured when the real list lands. It is dropped
     * only where the user actually said so, a disconnect of that exact account (disconnectAccount), or a new
     * pick (selectAccount / a connect). */
    repointStranded(target, list);
    return list;
};

/* Read every connection this sandbox holds, the providers' own accounts AND the translator's subscriptions.
 * One call, because to a user they are one question ("what is my agent signed in with?"), and because the
 * answer has to arrive as one state: two independently-landing halves is a card that rearranges itself twice.
 *
 * Landing the reads is also what earns the right to say "not connected": `accountsLoaded` flips only if a read
 * actually came back, so a daemon that is unreachable or mid-restart leaves the surfaces waiting (the reachable
 * seam retries) instead of asserting an empty state it cannot back up. The translator read is excluded from
 * that vote deliberately, it swallows its own failure, so it always "succeeds". */
const readConnections = async (force: boolean): Promise<void> => {
    /* FORCED, EVERY PROVIDER RE-MEASURES FIRST. The daemon holds a reading for a minute before it goes back
     * upstream, which is right for every read the app takes on its own and wrong for the one a person asks
     * for: they press it because they doubt the number on screen. One route sweeps every connection, Claude's
     * and the translator's alike, and the lists read afterwards carry what it found. It used to reach Claude
     * alone, behind a button whose label promised every connection. */
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

// The unforced read in flight, so three surfaces mounting together (the picker, the rail, the Usage tab) cost
// one round of requests and all wait on it. A forced read is never joined: it was asked for precisely to go
// behind whatever the one in flight is about to answer.
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

// Everything daemon-owned the chat needs, on the seam where it can first be read. Module-exported (like
// resetChat) for sandboxScope, which re-runs it whenever the active daemon becomes reachable, connections and
// catalogs live on the daemon, so reachability is the moment either can actually be asked for.
export const loadAccountStatus = async (): Promise<void> => {
    await Promise.all([
        // Which accounts and subscriptions this sandbox is signed in with, the gate every provider surface reads.
        refreshConnections(),
        // Model lists are daemon-owned too, load them on the same reachable seam so the pickers are ready.
        loadAllProviderModels(),
        // Installed ACP agents and model endpoints are providers too, surface them on the same seam.
        loadCapabilityProviders(),
        /* Claude's last-published slash commands, so the common case has a populated `/` popover the instant a
         * conversation opens rather than one request later. Claude only HERE, deliberately: it is the default
         * provider, and an ACP provider isn't even known until loadCapabilityProviders resolves. Every other
         * provider — and this one, when the daemon had nothing to say yet — is read by the composer that needs
         * it (ensureProviderCommands), which is what makes this a head start rather than the only chance. */
        loadProviderCommands(`claude`),
    ]);
};

// Swap one account of a provider in place, leaving order and selection alone, the difference between a WRITE
// to an existing account and a new one arriving (see addAccount, which moves it to the end and selects it).
const replaceAccount = (target: AgentProvider, next: OauthAccount): void => {
    providerAccounts.value = {
        ...providerAccounts.value,
        [target]: accountsOf(target).map((entry) => (entry.id === next.id ? next : entry)),
    };
};

/* Rename one account of the managed provider. The credential is untouched, this writes the DISPLAY NAME, the
 * one thing that lets a second connection of the same provider tell itself apart when the provider hands back
 * no identity to derive one from (a pasted API key), or when the derived one isn't what the user calls it.
 *
 * Applied to the list BEFORE the round-trip and reconciled after: the name is the user's own keystrokes, so
 * showing it back to them is not a guess, and a rename that repaints a tunnel-latency later reads as one that
 * didn't take. The daemon's answer still wins (a blank means "back to the derived name", which only it knows),
 * and a failure re-reads rather than leaving an optimistic name standing over a write that never landed.
 *
 * Deliberately does NOT take `accountBusy`: that ledger drives the row's Disconnect spinner and gates
 * `startConnect`, and a rename is neither of those things. */
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
        // A 404 means the row is gone (disconnected from another device or another tab), so re-read rather than
        // restore a name onto an account that no longer exists: the honest answer to a failed write is the
        // current truth, not the state we came from.
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

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second account record
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
