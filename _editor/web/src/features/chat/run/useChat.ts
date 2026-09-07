import type { AgentCommand, OauthAccount } from "@intentic/sandbox-contract";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { accountsLoaded, noTranslatorAccounts, providerAccounts, providerRefusals, translatorAccounts, usageByAccount } from "../accounts/providerAccounts";
import {
    type CatalogLoadState,
    endpointProviders,
    endpointsLoaded,
    type ModelOption,
    perProvider,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
} from "../accounts/providerCatalog";
import { turnDefaults } from "./turnDefaults";
import {
    active,
    activeId,
    closePane,
    closeRetired,
    closeTabs,
    collapsePanes,
    composerFocus,
    conversations,
    keepChat,
    openBeside,
    panes,
    restoreTabs,
    setActive,
    setPanes,
    tabReveal,
} from "../tabs/useChat-tabs";
import { attachStarted, loadSessions, paintCachedTranscripts, sessions } from "./useChat-sessions";
import { retireCommandReads } from "../models/useChat-catalog";
import { hasSignIn } from "../session/access";
import {
    accountBusy,
    accountUsage,
    claudeConnected,
    disconnect,
    error,
    loadUsage,
    managedAccounts,
    managedProvider,
    renameAccount,
    setManagedProvider,
    usageLoaded,
} from "../accounts/useChat-accounts";
import {
    cancelConnect,
    cancelTranslatorConnect,
    completeConnect,
    completeTranslator,
    connectLabel,
    connectTranslator,
    disconnectTranslator,
    nativeConnectFlow,
    showActiveProvider,
    startConnect,
    translatorConnectFlow,
    translatorKey,
} from "./useChat-connect";
import { conversationView } from "../panel/useChat-view";
import { openConversation } from "../panel/useChat-reveal";

/* Manages the shared Claude Code chat as a module-level singleton: a set of concurrent conversations (the
 * tabs), plus the global account connection and turn preferences. A singleton
 * so the open conversations survive navigation between workspace areas (the chat panel lives in the
 * persistent shell). Each Conversation owns its own stream, so a background tab keeps generating while the
 * user views another.
 *
 * A singleton PER WINDOW: every browser window runs a full copy of the app with its own tab set (windowStore
 * has why), and only daemon-backed state converges between them on its own. What does cross windows is the
 * SUMMONS, a surface outside the panel showing a chat goes through summon.ts, which applies the same reveal
 * in every window, so a click made in any of them is followed by all of them, the chat's own floating window
 * included.
 *
 * WHILE THE CHAT IS DRAWN BY ANOTHER WINDOW, this window's tab list is a SHADOW: the tabs it built before the
 * panel left plus every summons since, with composers frozen at whatever they last heard. It is kept for the
 * actions that need a Conversation to act on from here (a resolve prompt sent from the board, a stop, a rename),
 * and it is replaced wholesale from the seed the moment the panel returns (restoreTabs). Nothing reads it for
 * DISPLAY: what the chat is showing is asked of `chatStrip` (useChat-strip.ts), which answers from this list only
 * while this window draws the chat and from the drawing window's published strip otherwise (chatEcho.ts). Every
 * defect the popped-out chat has had was a reader mixing the two. */

// The focused conversation's view, what the store itself binds, and what every surface outside the chat panel
// reads through `useChat()`.
const activeView = conversationView(active);
const {
    messages,
    streaming,
    availableCommands,
    awaitingDecision,
    pendingPlanMessage,
    queued,
    removeQueued,
    steerable,
    capabilities,
    activeModel,
    contextUsage,
    mode,
    provider,
    selectProvider,
    harness,
    selectHarness,
    model,
    selectModel,
    effort,
    thinking,
    fast,
    fastOffered,
    fastMode,
    account,
    selectAccount,
    accounts,
    connected,
    draft,
    attachments,
    send,
    stop,
    forkAt,
    decidePlan,
    answerQuestion,
    cancelQuestion,
    decidePermission,
} = activeView;

// Reset the whole chat singleton when the active sandbox changes (see sandboxScope). Conversations, history,
// and the account-connection state all belong to the sandbox they were loaded from, carrying them onto a
// different sandbox would stream against the wrong daemon and show its "connected" status falsely.
export const resetChat = (): void => {
    for (const conversation of conversations.value) {
        conversation.abort();
    }
    /* Dropped BEFORE the tabs are rebuilt, not with the rest of the sandbox-scoped state below: restoring a tab
     * resolves its account against these, and the outgoing sandbox's list is not an answer about the incoming
     * one, it would validate the new sandbox's remembered pick against credentials from the old, and hand every
     * restored tab a foreign account id as the "first" one.
     *
     * Cleared rather than emptied-and-declared: the incoming sandbox's connections are unknown until ITS daemon
     * answers, and every surface shows that as a wait rather than as "you have nothing connected". */
    providerAccounts.value = perProvider<readonly OauthAccount[]>(() => []);
    accountsLoaded.value = false;
    // Rebuilds the tabs AND re-seeds the account pick from the incoming sandbox's own remembered one.
    restoreTabs();
    // The new sandbox's tabs get the same instant paint a reload does; the mirror is keyed by conversation, so
    // a switch reads that sandbox's transcripts, never the one just left.
    paintCachedTranscripts(conversations.value);
    sessions.value = [];
    providerModels.value = perProvider<ModelOption[]>(() => []);
    providerCommands.value = perProvider<readonly AgentCommand[]>(() => []);
    retireCommandReads();
    providerDefaultModel.value = perProvider(() => ``);
    providerModelsState.value = perProvider<CatalogLoadState>(() => `idle`);
    // Which endpoints the INCOMING sandbox has, the free trial among them, is unknown until its own daemon
    // answers: the same wait `accountsLoaded` above declares, for the other half of the same picture.
    endpointProviders.value = [];
    endpointsLoaded.value = false;
    /* The account card opens on the user's remembered pick, but ONLY where that pick is a provider it can
     * connect. The picker writes whatever was chosen, the free trial and a model endpoint included, and neither
     * holds a credential this card adds or drops; seeding one leaves the card showing rows for a provider that
     * has no sign-in, under a raw id, with no chip lit. Keeping the previous value is safe by induction: every
     * writer of `managedProvider` passes the same test. */
    if (hasSignIn(turnDefaults.provider.value)) {
        managedProvider.value = turnDefaults.provider.value;
    }
    cancelConnect();
    cancelTranslatorConnect();
    accountBusy.value = undefined;
    translatorAccounts.value = noTranslatorAccounts();
    // Nor its headroom: the map is keyed by ids the outgoing daemon minted.
    usageByAccount.value = {};
    // The outgoing sandbox's totals are not an answer about the incoming one, so its rows wait again.
    accountUsage.value = {};
    usageLoaded.value = false;
    providerRefusals.value = {};
    error.value = null;
};

export function useChat() {
    return {
        conversations,
        activeId,
        active,
        panes,
        openBeside,
        closePane,
        collapsePanes,
        setPanes,
        sessions,
        messages,
        streaming,
        availableCommands,
        awaitingDecision,
        pendingPlanMessage,
        activeModel,
        contextUsage,
        capabilities,
        mode,
        provider,
        selectProvider,
        harness,
        selectHarness,
        account,
        selectAccount,
        accounts,
        managedAccounts,
        accountUsage,
        usageLoaded,
        model,
        selectModel,
        effort,
        thinking,
        fast,
        fastOffered,
        fastMode,
        draft,
        attachments,
        error,
        connected,
        claudeConnected,
        managedProvider,
        setManagedProvider,
        nativeConnectFlow,
        connectLabel,
        accountsLoaded,
        accountBusy,
        translatorKey,
        composerFocus,
        tabReveal,
        setActive,
        keepChat,
        closeTabs,
        closeRetired,
        attachStarted,
        send,
        queued,
        removeQueued,
        steerable,
        forkAt,
        stop,
        decidePlan,
        answerQuestion,
        cancelQuestion,
        decidePermission,
        loadSessions,
        openConversation,
        showActiveProvider,
        loadUsage,
        startConnect,
        completeConnect,
        cancelConnect,
        renameAccount,
        disconnect,
        translatorAccounts,
        translatorConnectFlow,
        connectTranslator,
        completeTranslator,
        cancelTranslatorConnect,
        disconnectTranslator,
    };
}

// One tab store per window: a hot update that re-ran this module would hand the panel a second, empty strip while
// the channel's readers went on writing to the first (hotReload.ts).
reloadOnHotUpdate(import.meta);
