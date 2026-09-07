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

/* ONE CONVERSATION, AS A PANEL BINDS IT, the facade every chat surface renders through, over whichever
 * conversation it was built for rather than over the focused one.
 *
 * It exists as a FACTORY because the chat panel shows several conversations at once (the floating window's panes): a
 * transcript, its composer, its pickers and its tool cards all have to answer for the chat they are IN, and a
 * module-level facade over `active` can only ever answer for the focused one. The singleton below builds its
 * own from `active`, so the store's exported surface, and every consumer outside the panel, is unchanged;
 * a pane builds one over its own conversation and is right by construction.
 *
 * Everything here is a computed or a function, so the factory can be called before the module bindings it
 * closes over (chatReady, setConversations, loadProviderModels) are initialized: nothing is dereferenced until
 * a surface reads it. */
export const conversationView = (conversation: ComputedRef<Conversation>) => ({
    conversation,
    messages: computed(() => conversation.value.messages.value),
    streaming: computed(() => conversation.value.streaming.value),
    // This conversation's slash commands: the list its own turns published (authoritative, it reflects the
    // session's live config), falling back to the provider's last daemon-published list so a conversation that
    // hasn't run a turn yet still has a populated `/` popover.
    availableCommands: computed<readonly AgentCommand[]>(() => {
        const own = conversation.value.availableCommands.value;
        return own.length > 0 ? own : (providerCommands.value[conversation.value.provider.value] ?? []);
    }),
    awaitingDecision: computed(() => conversation.value.awaitingDecision.value),
    /* This card's answer is already on its way, so the OTHER answers beside it must stop offering themselves.
     * A card is one question with several buttons, and locking only the pressed one leaves the two next to it
     * live over a decision that has already been made (see Conversation.deciding). */
    isDeciding: (message: ChatMessage): boolean => conversation.value.isDeciding(message.id),
    pendingPlanMessage: computed(() => conversation.value.pendingPlanMessage.value),
    /* This conversation's last turn ended before its work did (Conversation.pickUp), and the sentence that would
     * pick it up. Two values rather than one because the composer needs them at different moments: the state
     * arms the strip, the offer and the Enter shortcut, and the sentence is only read at the press.
     *
     * The offer stands down while a turn is live. A pick-up outlives the failure it describes until the next
     * turn STARTS, and the gap between a send leaving the composer and that turn beginning is real, long
     * enough, on a slow round-trip, for the strip to sit there under a message the user has already sent,
     * inviting them to send another. */
    pickUp: computed(() => (conversation.value.streaming.value ? undefined : conversation.value.pickUp.value)),
    continuation: computed(() => continuationFor(conversation.value.messages.value)),
    /* THE PRESS ITSELF, rather than the sentence it used to be spelled as. The composer had the sentence and did
     * the sending, which was fine for as long as continuing could only mean "say carry on"; now it can also mean
     * "run the held turn again" (Conversation.continueTurn), and that choice reads state no view should be asking
     * about. `continuation` above stays, the composer still shows the words the press would send. */
    continueTurn: (options?: { readonly carry?: boolean }): Promise<string | undefined> => {
        /* A continuation that gets SENT is a message like any other and belongs in the funnel; a held turn
         * re-run said nothing and must not inflate it. Predicted from the pick-up rather than read off the
         * answer, for the same reason `send` above fires before it awaits: both fields describe the conversation
         * as it stands BEFORE the press, and `queued` measured after one is true by construction. The prediction
         * is wrong only where the daemon has quietly dropped the hold, which is a fallback nobody is counting. */
        if (conversation.value.pickUp.value?.held === undefined) {
            track(`message_sent`, { agent: conversation.value.provider.value, queued: conversation.value.streaming.value });
        }
        return conversation.value.continueTurn(options);
    },
    /* ...and the standing version of that press: whether this chat continues itself, and when the one it has
     * scheduled goes (Conversation.autoContinue). The instant is what the strip counts down to, the wait has to
     * be visible, or a chat quietly sitting on a timer is indistinguishable from one nothing is happening to. */
    autoContinue: computed(() => conversation.value.autoContinue.value),
    autoContinueAt: computed(() => conversation.value.autoContinueAt.value),
    setAutoContinue: (on: boolean): void => conversation.value.setAutoContinue(on),
    // This conversation's undelivered messages (submitted while its turn was running) and whether its running
    // turn can take one mid-flight, the composer renders the first and words its hints from the second.
    queued: computed(() => conversation.value.queued.value),
    removeQueued: (id: string): void => conversation.value.removeQueued(id),
    steerable: computed(() => conversation.value.steerable.value),
    // What this conversation's runtime can do (the contract's declared record), the composer reads it to
    // offer only the controls something applies, and to say what this provider can't do at all.
    capabilities: computed(() => conversation.value.capabilities.value),
    activeModel: computed(() => conversation.value.activeModel.value),
    contextUsage: computed(() => conversation.value.contextUsage.value),
    // This conversation's permission mode (read + write), the composer's mode pill drives it. Reads the
    // RUNNING turn's posture while one is live (the agent can enter plan mode on its own, and the pill must not
    // claim otherwise); a pick replaces it, because from that click on the user's choice is the truth. Not
    // written through to the persisted defaults: the posture belongs to the conversation, not to the next one.
    mode: computed<PermissionMode>({
        get: () => conversation.value.liveMode.value ?? conversation.value.mode.value,
        set: (value) => {
            conversation.value.modePick.value = value;
            conversation.value.liveMode.value = undefined;
        },
    }),
    // Turn settings (read+write), the composer binds these, so switching tabs shows that chat's
    // provider/model/effort/thinking. All of it is switchable mid-chat: a provider/account switch takes effect
    // at the next send (see Conversation.send's segment cut).
    provider: computed<AgentProvider>(() => conversation.value.provider.value),
    selectProvider: (p: AgentProvider): void => {
        conversation.value.selectProvider(p);
        // The catalog is daemon-owned and can be stale (loaded before the account connected, or an empty
        // transient), refetch on landing so the model picker is populated on arrival (the daemon caches, so
        // this is cheap).
        void loadProviderModels(p);
    },
    // The harness (Default = the provider's native runtime, vs the Claude Code loop). Only meaningful for
    // codex/grok; picked through the model picker's footer chips. A switch retires the session at the next send.
    harness: computed<AgentHarness>(() => conversation.value.harness.value),
    // Switch the harness, an axis orthogonal to the model now (the catalog is shared, so the chosen model
    // rides across). No-ops on claude (always its own loop) and mid-stream (selectHarness guards both).
    selectHarness: (next: AgentHarness): void => conversation.value.selectHarness(next),
    model: computed<string>({
        get: () => conversation.value.model.value,
        set: (value) => conversation.value.selectModel({ provider: conversation.value.provider.value, value }),
    }),
    // Conversation.selectModel is the whole rule (provider re-point, remembering the pair, the mid-stream
    // guard); what this adds is the catalog refetch, which only a surface that did not open the picker needs,
    // the picker warms every catalog on mount and so drives the conversation directly.
    selectModel: (pick: TurnPick): void => {
        conversation.value.selectModel(pick);
        void loadProviderModels(pick.provider);
    },
    // The effort the composer shows is the EFFECTIVE one (the pick clamped to the current model's scale);
    // setting it records a new pick, on this conversation and as the seed for the next new chat.
    effort: computed<string>({
        get: () => conversation.value.effort.value,
        set: (value) => conversation.value.setEffort(value),
    }),
    thinking: computed<boolean>({
        get: () => conversation.value.thinking.value,
        set: (value) => conversation.value.setThinking(value),
    }),
    // Fast speed: the pick, whether the control is offered at all for the current provider/model, and what the
    // last turn actually ran at. Three values rather than one because they answer different questions, what
    // the user asked for, whether asking is even possible here, and what came back.
    fast: computed<boolean>({
        get: () => conversation.value.fast.value,
        set: (value) => conversation.value.setFast(value),
    }),
    fastOffered: computed<boolean>(() => conversation.value.fastOffered.value),
    fastMode: computed(() => conversation.value.fastMode.value),
    // Account facades: this conversation's account selection + the connected accounts of its provider, for the
    // composer switcher.
    account: computed<string | undefined>(() => conversation.value.account.value),
    selectAccount: (id: string): void => conversation.value.selectAccount(id),
    accounts: computed<readonly OauthAccount[]>(() => accountsOf(conversation.value.provider.value)),
    /* The persona this chat acts as (read + write), the composer's persona pill drives it, and it is the one
     * control on this list that is about the outside world rather than about the model. Undefined is "anyone":
     * every connected account stays reachable, which is what an attended chat gets when it names nobody.
     *
     * Switchable at any point, including mid-conversation: the daemon resolves the card per TURN, so the pick
     * lands on the next message rather than needing a fresh chat. */
    actsAs: computed<string | undefined>({
        get: () => conversation.value.actsAs.value,
        set: (value) => {
            conversation.value.actsAs.value = value;
        },
    }),
    /* Whether this conversation's selection can actually send, the composer gate, which is `providerReadyOn`
     * (access.ts) and nothing else.
     *
     * It used to be a second copy of that rule living in this file, and the copy is what let the free trial
     * exist without being usable: `providerReady` learned about endpoint providers, the copy never did, so a
     * sandbox on the trial listed a trial row with an allowance badge on it and kept the composer shut the
     * moment anybody chose it. One rule, read by the picker and the composer alike, is the only arrangement in
     * which those two cannot drift apart again. */
    connected: computed(() => providerReadyOn(conversation.value.provider.value, conversation.value.harness.value)),
    // This conversation's composer draft (text + staged attachments), per-tab, so switching tabs swaps the
    // composer back to whatever was typed and attached there.
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
    /* ASK THIS TURN AGAIN, DIFFERENTLY, the composer aimed at a message already in the transcript.
     *
     * The third way back, beside the two the cut already offered, and the one the other two were standing in
     * for: a fork answers "keep both paths" and a rewind answers "drop what followed", and neither is what a
     * user means when they simply mistyped a filename. Forking for that costs a tab per typo; rewinding first
     * and retyping from memory costs the words themselves. So this is the light path, and it is only light
     * because it commits nothing until the send (see Conversation.editing).
     *
     * `editing` is read by the transcript (to strike the rows the send would drop) and by the composer (to say
     * whose message it is holding), which is why it is on the view rather than private to one surface. */
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
    // The composer's one send path, whatever the conversation is doing: an idle chat starts a turn, a running one
    // takes the message mid-turn (or holds it until it settles). See Conversation.enqueue.
    send: (prompt: string, staged?: readonly ChatAttachment[], editorContext?: EditorContext): Promise<void> => {
        // Core funnel milestone (autocapture misses Enter-key sends); PostHog derives "first message" per person.
        track(`message_sent`, { agent: conversation.value.provider.value, queued: conversation.value.streaming.value });
        return conversation.value.enqueue(prompt, staged, editorContext);
    },
    stop: (): void => {
        conversation.value.stop();
    },
    /* FORK THE CONVERSATION AT A CUT, everything above the cut is copied into a fresh tab, and the source is
     * left completely alone, so the answer being replaced is still there to compare against and nothing is
     * destroyed by an experiment.
     *
     * `cut` is the index of the first message BELOW the line, which is the one number the whole affordance turns
     * on: it is how many bubbles the fork inherits, and it is also what decides what the composer opens with.
     * A cut above a user message means "redo this turn differently", so that prompt (and its attachments) is
     * loaded into the composer ready to be edited, the fork of the whole conversation, cut past the last
     * message, opens with an empty one instead.
     *
     * NOTHING IS SENT. The fork opens with the prompt sitting in the composer where the user can read it, change
     * it, or replace it entirely, which is what makes forking without editing possible at all, and what stops a
     * half-considered prompt from running the moment the tab appears. The old edit-then-auto-send did the
     * opposite on both counts. */
    forkAt: (cut: number, files: "then" | "now"): Conversation | undefined => {
        const source = conversation.value;
        if (cut < 0 || cut > source.messages.value.length) {
            return undefined;
        }
        /* A RUNNING TURN DOES NOT BLOCK THE CHAT HALF OF THIS. Copying the turns above the cut into a new tab
         * takes nothing away from the run still writing below it, and a turn that has been going twenty
         * minutes is exactly when a second line of attack is worth opening, refusing then made the control
         * useless at the one moment it was wanted. What a running turn does block is the FILES: putting a
         * checkpoint back underneath an agent writing to those same files is a different act, so that half
         * waits for the turn to end. */
        if (files === `then` && source.streaming.value) {
            return undefined;
        }
        const fork = new Conversation();
        fork.forkFrom(source, cut, files);
        // The message the cut sits above, when it is one of the user's: the fork opens holding it, so "fork and
        // ask it differently" is one gesture rather than a fork followed by a hunt for what was said.
        const below = source.messages.value[cut];
        if (below?.role === `user`) {
            fork.draft.value = below.text;
        }
        setConversations([...conversations.value, fork], fork.conversationId, `fork`);
        track(`conversation_forked`, { agent: fork.provider.value, files, whole: cut === source.messages.value.length });
        /* HANDED BACK rather than left to be fished out of the tab list, because one caller needs to say
         * something about the fork it just made: the edit's "keep both instead" puts the half-typed replacement
         * into it (see ChatPane's forkInsteadOfEdit). Finding it by position would work today and break the
         * first time a fork lands anywhere but the end of the list. */
        return fork;
    },
    // Approving runs the plan (under bypassPermissions, the daemon's call, not the card's); a rejection leaves
    // the agent in plan mode to revise, with the composer's text and staged files as the feedback.
    decidePlan: (message: ChatMessage, approve: boolean, feedback?: string, staged?: readonly ChatAttachment[]): Promise<void> =>
        conversation.value.decidePlan(message, approve, feedback, staged),
    answerQuestion: (message: ChatMessage, answers: Record<string, string[]>): Promise<void> => conversation.value.answerQuestion(message, answers),
    cancelQuestion: (message: ChatMessage): Promise<void> => conversation.value.cancelQuestion(message),
    decidePermission: (message: ChatMessage, decision: "once" | "always" | "deny", feedback?: string): Promise<void> =>
        conversation.value.decidePermission(message, decision, feedback),
    // The setup click for a missing-capability ask, connect (and go set it up) or continue without it.
    decideCapabilityOffer: (message: ChatMessage, connect: boolean): Promise<void> => conversation.value.decideCapabilityOffer(message, connect),
    // The pay click for a USDC payment, the only thing that releases it (or skips it, spending nothing).
    decidePaymentOffer: (message: ChatMessage, approve: boolean): Promise<void> => conversation.value.decidePaymentOffer(message, approve),
    /* The release click for a gated credential, and the only decide here that is not simply the viewer's to
     * make: the daemon checks the clicker against the names on the card and refuses anybody else, leaving
     * the card up for whoever can (secrets/credential-gate.ts). */
    decideCredentialOffer: (message: ChatMessage, approve: boolean): Promise<void> => conversation.value.decideCredentialOffer(message, approve),
    // "Can't help now" for a browser-help card; "hand back" lives on /browsers, beside the live stage.
    declineBrowserHelp: (message: ChatMessage): Promise<void> => conversation.value.declineBrowserHelp(message),
    // The same for a terminal-help card; "hand back" lives on the terminal panel, over the waiting prompt.
    declineTerminalHelp: (message: ChatMessage): Promise<void> => conversation.value.declineTerminalHelp(message),
});

export type ConversationView = ReturnType<typeof conversationView>;

/* THE PANE'S VIEW, for the surfaces under it, the transcript rows, their tool cards, the mode menu, the
 * account panel. Injected rather than threaded through four levels of props, and it is the pane's OWN view:
 * a tool card in the right-hand pane must answer for the chat it is in, not for whichever one has the focus.
 * Absent means the component was mounted outside a pane, which is a wiring mistake rather than a state to
 * render, so it is discovered at mount instead of silently rendering the focused chat's content. */
export const PANE_VIEW: InjectionKey<ConversationView> = Symbol(`chat-pane-view`);
export const usePaneView = (): ConversationView => {
    const view = inject(PANE_VIEW);
    if (view === undefined) {
        throw new Error(`a chat surface was mounted outside a ChatPane`);
    }
    return view;
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second PANE_VIEW key,
// the injection-key symptom hotReload.ts names, beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
