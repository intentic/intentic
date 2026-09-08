import type { AgentCommand, AgentHarness, AgentProvider, EditorContext, OauthAccount, PermissionMode } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, inject, type InjectionKey } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { Conversation, type PendingAttachment } from "../session/conversation";
import { providerCommands } from "../accounts/providerCatalog";
import type { TurnPick } from "../run/turnDefaults";
import { providerReadyOn } from "../session/access";
import { type ChatAttachment, type ChatMessage, continuationFor } from "../transcript/transcript";
import { conversations, setConversations } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../models/useChat-catalog";
import { accountsOf } from "../accounts/useChat-accounts";
import { track } from "../../../app/analytics";

// One conversation, as a panel binds it: the facade every chat surface renders through. Built per pane rather than over
// `active`, since the floating window shows several conversations at once.
export const conversationView = (conversation: ComputedRef<Conversation>) => ({
    conversation,
    messages: computed(() => conversation.value.messages.value),
    streaming: computed(() => conversation.value.streaming.value),
    // This chat's slash commands: its own turns' list if any, else the provider's last known list.
    availableCommands: computed<readonly AgentCommand[]>(() => {
        const own = conversation.value.availableCommands.value;
        return own.length > 0 ? own : (providerCommands.value[conversation.value.provider.value] ?? []);
    }),
    awaitingDecision: computed(() => conversation.value.awaitingDecision.value),
    // True for the whole card once any button was pressed, so every button on it locks, not just the one clicked.
    isDeciding: (message: ChatMessage): boolean => conversation.value.isDeciding(message.id),
    pendingPlanMessage: computed(() => conversation.value.pendingPlanMessage.value),
    // Undefined while streaming, since a pick-up outlives its failure until the next turn actually starts; the state
    // arms the strip immediately after a send, before that turn begins.
    pickUp: computed(() => (conversation.value.streaming.value ? undefined : conversation.value.pickUp.value)),
    continuation: computed(() => continuationFor(conversation.value.messages.value)),
    // The press itself, not the sentence it sends: continuing may re-run a held turn rather than send a message, a
    // choice that reads state (`Conversation.continueTurn`) no view should ask about directly.
    continueTurn: (options?: { readonly carry?: boolean }): Promise<string | undefined> => {
        // Tracks only a continuation that actually sends a message; a held-turn re-run says nothing new and must not
        // count as one.
        if (conversation.value.pickUp.value?.held === undefined) {
            track(`message_sent`, { agent: conversation.value.provider.value, queued: conversation.value.streaming.value });
        }
        return conversation.value.continueTurn(options);
    },
    // The standing version of continueTurn: whether this chat keeps continuing itself, and when the next one fires. The
    // instant must stay visible, or a scheduled continue looks like nothing is happening.
    autoContinue: computed(() => conversation.value.autoContinue.value),
    autoContinueAt: computed(() => conversation.value.autoContinueAt.value),
    setAutoContinue: (on: boolean): void => conversation.value.setAutoContinue(on),
    // Undelivered messages sent mid-turn, and whether the running turn can actually take one right now.
    queued: computed(() => conversation.value.queued.value),
    removeQueued: (id: string): void => conversation.value.removeQueued(id),
    steerable: computed(() => conversation.value.steerable.value),
    // What this conversation's runtime can do, from the contract's declared record.
    capabilities: computed(() => conversation.value.capabilities.value),
    activeModel: computed(() => conversation.value.activeModel.value),
    contextUsage: computed(() => conversation.value.contextUsage.value),
    // Reads the running turn's own posture when one is live (a pick can't override an agent already in plan mode); a
    // pick replaces it once made. Not persisted to defaults: mode belongs to the conversation, not the next one.
    mode: computed<PermissionMode>({
        get: () => conversation.value.liveMode.value ?? conversation.value.mode.value,
        set: (value) => {
            conversation.value.modePick.value = value;
            conversation.value.liveMode.value = undefined;
        },
    }),
    // Turn settings (read+write) the composer binds to a tab; all switchable mid-chat, taking effect at the next send.
    provider: computed<AgentProvider>(() => conversation.value.provider.value),
    selectProvider: (p: AgentProvider): void => {
        conversation.value.selectProvider(p);
        // Refetches since the catalog can be stale (loaded before the account connected); cheap, since the daemon
        // caches it.
        void loadProviderModels(p);
    },
    // Native runtime vs. Claude Code's loop, for codex/grok only; a switch retires the session next send.
    harness: computed<AgentHarness>(() => conversation.value.harness.value),
    // Orthogonal to model choice now (catalog is shared); no-op on claude or mid-stream.
    selectHarness: (next: AgentHarness): void => conversation.value.selectHarness(next),
    model: computed<string>({
        get: () => conversation.value.model.value,
        set: (value) => conversation.value.selectModel({ provider: conversation.value.provider.value, value }),
    }),
    // selectModel itself holds the whole rule; this adds only the catalog refetch a surface that skipped the picker
    // still needs.
    selectModel: (pick: TurnPick): void => {
        conversation.value.selectModel(pick);
        void loadProviderModels(pick.provider);
    },
    // Shows the effective effort (pick clamped to the model's scale); setting seeds the next new chat too.
    effort: computed<string>({
        get: () => conversation.value.effort.value,
        set: (value) => conversation.value.setEffort(value),
    }),
    thinking: computed<boolean>({
        get: () => conversation.value.thinking.value,
        set: (value) => conversation.value.setThinking(value),
    }),
    // Three values since they answer different questions: what was picked, whether picking is even offered here, and
    // what the last turn actually ran at.
    fast: computed<boolean>({
        get: () => conversation.value.fast.value,
        set: (value) => conversation.value.setFast(value),
    }),
    fastOffered: computed<boolean>(() => conversation.value.fastOffered.value),
    fastMode: computed(() => conversation.value.fastMode.value),
    // Account facades: this conversation's pick, plus its provider's connected accounts, for the switcher.
    account: computed<string | undefined>(() => conversation.value.account.value),
    selectAccount: (id: string): void => conversation.value.selectAccount(id),
    accounts: computed<readonly OauthAccount[]>(() => accountsOf(conversation.value.provider.value)),
    // The persona this chat acts as; undefined means anyone, keeping every connected account reachable. Resolved per
    // turn by the daemon, so a switch lands on the next message without a fresh chat.
    actsAs: computed<string | undefined>({
        get: () => conversation.value.actsAs.value,
        set: (value) => {
            conversation.value.actsAs.value = value;
        },
    }),
    // Whether this conversation's selection can send: exactly `providerReadyOn` and nothing else, so the composer and
    // the picker can never read this differently.
    connected: computed(() => providerReadyOn(conversation.value.provider.value, conversation.value.harness.value)),
    // Per-tab composer draft (text + attachments); switching tabs swaps to what was typed there.
    draft: computed<string>({
        get: () => conversation.value.draft.value,
        set: (value) => {
            conversation.value.draft.value = value;
        },
    }),
    attachments: computed<PendingAttachment[]>({
        get: () => conversation.value.attachments.value,
        set: (value) => {
            conversation.value.attachments.value = value;
        },
    }),
    // Aims the composer at a message already in the transcript, committing nothing until the send. Shared with the
    // transcript (to strike rows the send would replace) rather than kept private to the composer.
    editing: computed<ChatMessage | undefined>(() => {
        const edit = conversation.value.editing.value;
        return edit === undefined ? undefined : conversation.value.messages.value.find((message) => message.id === edit.id);
    }),
    beginEdit: (message: ChatMessage): boolean => conversation.value.beginEdit(message),
    cancelEdit: (): void => {
        conversation.value.cancelEdit();
    },
    submitEdit: (text: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<boolean> => {
        track(`message_edited`, { agent: conversation.value.provider.value });
        return conversation.value.submitEdit(text, staged, editorContext);
    },
    // The one send path regardless of state: an idle chat starts a turn, a running one takes the message mid-turn or
    // holds it.
    send: (prompt: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<void> => {
        // Funnel milestone missed by autocapture (Enter-key sends); PostHog derives "first message" from it.
        track(`message_sent`, { agent: conversation.value.provider.value, queued: conversation.value.streaming.value });
        return conversation.value.enqueue(prompt, staged, editorContext);
    },
    stop: (): void => {
        conversation.value.stop();
    },
    // Forks the conversation at `cut` (the index of the first message below the line) into a fresh tab, leaving the
    // source untouched. A cut above a user message reopens that prompt in the new composer instead of sending it.
    forkAt: (cut: number, files: "then" | "now"): Conversation | undefined => {
        const source = conversation.value;
        if (cut < 0 || cut > source.messages.value.length) {
            return undefined;
        }
        // Only the file checkpoint waits for a running turn to end; copying the chat above the cut never blocks on it.
        if (files === `then` && source.streaming.value) {
            return undefined;
        }
        const fork = new Conversation();
        fork.forkFrom(source, cut, files);
        // Reopens the cut prompt in the fork's composer when it was the user's, so editing it is one gesture.
        const below = source.messages.value[cut];
        if (below?.role === `user`) {
            fork.draft.value = below.text;
        }
        setConversations([...conversations.value, fork], fork.conversationId, `fork`);
        track(`conversation_forked`, { agent: fork.provider.value, files, whole: cut === source.messages.value.length });
        // Returned directly rather than looked up by position, since a caller (ChatPane's forkInsteadOfEdit) needs to
        // act on the fork it just made.
        return fork;
    },
    // Approving runs the plan under bypassPermissions; rejecting keeps plan mode, with the composer as feedback.
    decidePlan: (message: ChatMessage, approve: boolean, feedback?: string, staged?: readonly ChatAttachment[]): Promise<void> =>
        conversation.value.decidePlan(message, approve, feedback, staged),
    answerQuestion: (message: ChatMessage, answers: Record<string, string[]>): Promise<void> => conversation.value.answerQuestion(message, answers),
    cancelQuestion: (message: ChatMessage): Promise<void> => conversation.value.cancelQuestion(message),
    decidePermission: (message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> =>
        conversation.value.decidePermission(message, decision, feedback),
    // The setup click for a missing-capability ask: connect and set it up, or continue without it.
    decideCapabilityOffer: (message: ChatMessage, connect: boolean): Promise<void> => conversation.value.decideCapabilityOffer(message, connect),
    // The pay click for a USDC payment; declining skips it and spends nothing.
    decidePaymentOffer: (message: ChatMessage, approve: boolean): Promise<void> => conversation.value.decidePaymentOffer(message, approve),
    // The only decide here not simply the viewer's call: the daemon checks the clicker against the card's named
    // accounts and refuses anyone else.
    decideCredentialOffer: (message: ChatMessage, approve: boolean): Promise<void> => conversation.value.decideCredentialOffer(message, approve),
    // Declines a browser-help card; "hand back" lives on /browsers instead.
    declineBrowserHelp: (message: ChatMessage): Promise<void> => conversation.value.declineBrowserHelp(message),
    // Same, for a terminal-help card; "hand back" lives on the terminal panel instead.
    declineTerminalHelp: (message: ChatMessage): Promise<void> => conversation.value.declineTerminalHelp(message),
});

export type ConversationView = ReturnType<typeof conversationView>;

// The pane's own view, injected rather than threaded through props, so a tool card in one pane answers for its own
// chat, not the focused one. Absent means mounted outside a pane, a wiring mistake surfaced at mount rather than
// silently rendering the wrong chat.
export const PANE_VIEW: InjectionKey<ConversationView> = Symbol(`chat-pane-view`);
export const usePaneView = (): ConversationView => {
    const view = inject(PANE_VIEW);
    if (view === undefined) {
        throw new Error(`a chat surface was mounted outside a ChatPane`);
    }
    return view;
};

// Singleton per window: a hot-reloaded rerun would mint a second injection key beside the one still in use.
reloadOnHotUpdate(import.meta);
