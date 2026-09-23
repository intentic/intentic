import type {
    AgentCommand,
    AgentHarness,
    AgentProvider,
    EditorContext,
    OauthAccount,
    PermissionMode,
    QueuedMessage,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef, inject, type InjectionKey } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { Conversation } from "../session/conversation";
import { seedFork } from "../session/forkSeed";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import { providerCommands } from "../accounts/providerCatalog";
import type { TurnPick } from "../run/turnDefaults";
import type { ForkLink } from "../run/turnRequest";
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
    messages: computed(() => conversation.value.transcript.messages.value),
    streaming: computed(() => conversation.value.turn.streaming.value),
    // This chat's slash commands: its own turns' list if any, else the provider's last known list.
    availableCommands: computed<readonly AgentCommand[]>(() => {
        const own = conversation.value.availableCommands.value;
        return own.length > 0 ? own : (providerCommands.value[conversation.value.selection.provider.value] ?? []);
    }),
    awaitingDecision: computed(() => conversation.value.transcript.awaitingDecision.value),
    pendingPlanMessage: computed(() => conversation.value.transcript.pendingPlanMessage.value),
    // Undefined while streaming, since a pick-up outlives its failure until the next turn actually starts; the state
    // arms the strip immediately after a send, before that turn begins.
    pickUp: computed(() => (conversation.value.turn.streaming.value ? undefined : conversation.value.pickUp.value)),
    continuation: computed(() => continuationFor(conversation.value.transcript.messages.value)),
    // The press itself, not the sentence it sends: continuing may re-run a held turn rather than send a message, a
    // choice that reads state (`TurnClient.continueTurn`) no view should ask about directly.
    continueTurn: (options?: { readonly carry?: boolean }): Promise<string | undefined> => {
        // Tracks only a continuation that actually sends a message; a held-turn re-run says nothing new and must not
        // count as one.
        if (conversation.value.pickUp.value?.held === undefined) {
            track(`message_sent`, { agent: conversation.value.selection.provider.value, queued: conversation.value.turn.streaming.value });
        }
        return conversation.value.turn.continueTurn(options);
    },
    // The standing version of continueTurn is not here: it is this conversation's answer to the ending's one question
    // (turnBreak.ts), owned by the daemon and read through the agent roster, so it survives this tab closing and
    // cannot disagree with the same switch on the board.
    // What waits in the conversation's queue for its next turn, the same in every window, and why it is held if it is;
    // and whether the running turn can actually take words right now.
    queued: computed<readonly QueuedMessage[]>(() => conversation.value.queue.value?.items ?? []),
    queuePaused: computed(() => conversation.value.queue.value?.paused),
    steerable: computed(() => conversation.value.selection.steerable.value),
    // What this conversation's runtime can do, from the contract's declared record.
    capabilities: computed(() => conversation.value.selection.capabilities.value),
    activeModel: computed(() => conversation.value.activeModel.value),
    contextUsage: computed(() => conversation.value.contextUsage.value),
    // Reads the running turn's own posture when one is live (a pick can't override an agent already in plan mode); a
    // pick replaces it once made. Not persisted to defaults: mode belongs to the conversation, not the next one.
    mode: computed<PermissionMode>({
        get: () => conversation.value.turn.liveMode.value ?? conversation.value.selection.mode.value,
        set: (value) => {
            conversation.value.selection.apply({ kind: `set`, picks: { modePick: value } });
            conversation.value.turn.liveMode.value = undefined;
        },
    }),
    // Turn settings (read+write) the composer binds to a tab; all switchable mid-chat, taking effect at the next send.
    provider: computed<AgentProvider>(() => conversation.value.selection.provider.value),
    selectProvider: (p: AgentProvider): void => {
        conversation.value.selection.apply({ kind: `selectProvider`, provider: p });
        // Refetches since the catalog can be stale (loaded before the account connected); cheap, since the daemon
        // caches it.
        void loadProviderModels(p);
    },
    // Native runtime vs. Claude Code's loop, for codex/grok only; a switch retires the session next send.
    harness: computed<AgentHarness>(() => conversation.value.selection.harness.value),
    model: computed<string>({
        get: () => conversation.value.selection.model.value,
        set: (value) =>
            conversation.value.selection.apply({ kind: `selectModel`, pick: { provider: conversation.value.selection.provider.value, value } }),
    }),
    // The `selectModel` pick holds the whole rule; this adds only the catalog refetch a surface that skipped the picker
    // still needs.
    selectModel: (pick: TurnPick): void => {
        conversation.value.selection.apply({ kind: `selectModel`, pick });
        void loadProviderModels(pick.provider);
    },
    // Shows the effective effort (pick clamped to the model's scale); setting seeds the next new chat too.
    effort: computed<string>({
        get: () => conversation.value.selection.effort.value,
        set: (value) => conversation.value.selection.apply({ kind: `setEffort`, effort: value }),
    }),
    thinking: computed<boolean>({
        get: () => conversation.value.selection.thinking.value,
        set: (value) => conversation.value.selection.apply({ kind: `setThinking`, thinking: value }),
    }),
    // Three values since they answer different questions: what was picked, whether picking is even offered here, and
    // what the last turn actually ran at.
    fast: computed<boolean>({
        get: () => conversation.value.selection.fast.value,
        set: (value) => conversation.value.selection.apply({ kind: `setFast`, fast: value }),
    }),
    fastMode: computed(() => conversation.value.fastMode.value),
    // Account facades: this conversation's pick, plus its provider's connected accounts, for the switcher.
    account: computed<string | undefined>(() => conversation.value.selection.account.value),
    accounts: computed<readonly OauthAccount[]>(() => accountsOf(conversation.value.selection.provider.value)),
    // The persona this chat acts as; undefined means anyone, keeping every connected account reachable. Resolved per
    // turn by the daemon, so a switch lands on the next message without a fresh chat.
    actsAs: computed<string | undefined>({
        get: () => conversation.value.selection.actsAs.value,
        set: (value) => {
            conversation.value.selection.apply({ kind: `set`, picks: { actsAs: value } });
        },
    }),
    // Whether this conversation's selection can send: exactly `providerReadyOn` and nothing else, so the composer and
    // the picker can never read this differently.
    connected: computed(() => providerReadyOn(conversation.value.selection.provider.value, conversation.value.selection.harness.value)),
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
    // Whether the composer holds anything of its own to send: words, or a staged file.
    staged: computed(() => conversation.value.draft.value.trim().length > 0 || conversation.value.attachments.value.length > 0),
    // Aims the composer at a message already in the transcript, committing nothing until the send. Shared with the
    // transcript (to strike rows the send would replace) rather than kept private to the composer.
    editing: computed<ChatMessage | undefined>(() => {
        const edit = conversation.value.transcript.editing.value;
        return edit === undefined ? undefined : conversation.value.transcript.messages.value.find((message) => message.id === edit.id);
    }),
    submitEdit: (text: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<boolean> => {
        track(`message_edited`, { agent: conversation.value.selection.provider.value });
        return conversation.value.transcript.submitEdit(text, staged, editorContext);
    },
    // The one send path regardless of state: an idle chat starts a turn, a running one takes the message mid-turn, and
    // otherwise the daemon queues it for the next.
    send: (prompt: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<void> => {
        // Funnel milestone missed by autocapture (Enter-key sends); PostHog derives "first message" from it.
        track(`message_sent`, { agent: conversation.value.selection.provider.value, queued: conversation.value.turn.streaming.value });
        return conversation.value.turn.say(prompt, staged, editorContext);
    },
    // The queue's doors, each acting on the message as this window read it, and letting a held queue go.
    unqueue: (message: QueuedMessage): Promise<boolean> => conversation.value.turn.unqueue(message),
    reword: (message: QueuedMessage, text: string): Promise<boolean> => conversation.value.turn.reword(message, text),
    resumeQueue: (): Promise<void> => conversation.value.turn.resume(),
    // Forks the conversation at `cut` (the index of the first message below the line) into a fresh tab, leaving the
    // source untouched. A cut above a user message reopens that prompt in the new composer instead of sending it.
    forkAt: (cut: number, files: ForkLink["files"]): Conversation | undefined => {
        const source = conversation.value;
        if (cut < 0 || cut > source.transcript.messages.value.length) {
            return undefined;
        }
        // Only the file checkpoint waits for a running turn to end; copying the chat above the cut never blocks on it.
        if (files === `then` && source.turn.streaming.value) {
            return undefined;
        }
        const fork = new Conversation();
        seedFork(fork, source, cut, files);
        // Reopens the cut prompt in the fork's composer when it was the user's, so editing it is one gesture.
        const below = source.transcript.messages.value[cut];
        if (below?.role === `user`) {
            fork.draft.value = below.text;
        }
        setConversations([...conversations.value, fork], fork.conversationId, `fork`);
        track(`conversation_forked`, { agent: fork.selection.provider.value, files, whole: cut === source.transcript.messages.value.length });
        // Returned directly rather than looked up by position: a caller (ChatEditNotice) acts on the fork it just made.
        return fork;
    },
});

export type ConversationView = ReturnType<typeof conversationView>;

// The pane's own view, injected rather than threaded through props, so a tool card in one pane answers for its own
// chat, not the focused one. Absent means mounted outside a pane, a wiring mistake surfaced at mount rather than
// silently rendering the wrong chat.
// `Symbol.for`, not `Symbol()`: a hot reload re-evaluates this module and would mint a fresh key, while the ChatPane
// already mounted still provides the old one, so every row mounted after the reload threw "outside a ChatPane" until a
// hard refresh. The global registry hands back the same symbol to every evaluation.
export const PANE_VIEW: InjectionKey<ConversationView> = Symbol.for(`intentic.chat-pane-view`);
export const usePaneView = (): ConversationView => {
    const view = inject(PANE_VIEW);
    if (view === undefined) {
        throw new Error(`a chat surface was mounted outside a ChatPane`);
    }
    return view;
};

// Singleton per window: a hot-reloaded rerun would mint a second injection key beside the one still in use.
reloadOnHotUpdate(import.meta);
