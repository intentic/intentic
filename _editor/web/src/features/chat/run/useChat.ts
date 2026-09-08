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

// Module-level singleton: the shared chat's open conversations (tabs), account connections, and turn
// preferences. One per window; while another window draws the chat, this window's tabs are a frozen shadow, and
// display goes through chatStrip (useChat-strip.ts), not this list directly.

// The focused conversation's view: what the store binds and what every surface outside the chat panel reads
// via useChat().
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

// Resets the chat singleton when the active sandbox changes (see sandboxScope): conversations, history, and
// account-connection state all belong to the sandbox they loaded from.
export const resetChat = (): void => {
    for (const conversation of conversations.value) {
        conversation.abort();
    }
    // Cleared before restoreTabs, or it validates new picks against the old sandbox's accounts.
    providerAccounts.value = perProvider<readonly OauthAccount[]>(() => []);
    accountsLoaded.value = false;
    // Rebuilds tabs and re-seeds the account pick from the incoming sandbox's own remembered one.
    restoreTabs();
    // Mirror is keyed by conversation, so new tabs paint from this sandbox's own cache, not the old one's.
    paintCachedTranscripts(conversations.value);
    sessions.value = [];
    providerModels.value = perProvider<ModelOption[]>(() => []);
    providerCommands.value = perProvider<readonly AgentCommand[]>(() => []);
    retireCommandReads();
    providerDefaultModel.value = perProvider(() => ``);
    providerModelsState.value = perProvider<CatalogLoadState>(() => `idle`);
    // Which endpoints (the free trial included) this sandbox has is unknown until its own daemon answers.
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
    // Keyed by ids the outgoing daemon minted, so it can't answer for the incoming sandbox either.
    usageByAccount.value = {};
    // Outgoing sandbox's totals aren't an answer for the incoming one, so these wait again too.
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

// Singleton per window: a hot update re-running this module would hand the panel a second, empty tab store.
reloadOnHotUpdate(import.meta);
