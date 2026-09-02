<script setup lang="ts">
import { Button, Icon, Notice, PersonaFace, ResponsiveOverlay, growTextarea, useDevice, useLoadingReveal } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { type AgentCommand, isTrialProvider, loopDesignLine } from "@intentic/sandbox-contract";
import { turnInFlight } from "../composables/agents/agentStatus";
import { boxNameOf, scopeOffered } from "../composables/agents/fleetScope";
import { useAgents } from "../composables/agents/useAgents";
import { modeMeta } from "../composables/chat/catalog";
import {
    type ComposerSituation,
    continueOffered,
    continueVisible,
    placeholderFor,
    sendable,
    sendHintFor,
    sendIntentOf,
    sendRefusal,
    VIEWER_PLACEHOLDER,
} from "../composables/chat/composerIntent";
import type { Conversation } from "../composables/chat/conversation";
import { modelLabelFor, providerDisplayLabel } from "../composables/chat/providerCatalog";
import { pickUpReady } from "../composables/chat/pickUp";
import { type ChatMessage, cutsAboveOf, dayMarksOf, forkCutsOf, turnsOf } from "../composables/chat/transcript";
import { withShortcut } from "../composables/commands/useCommands";
import { navigateInApp } from "../composables/mainWindow";
import { invalidateAgentTranscript } from "../composables/chat/agentTranscript";
import { conversationView, hydrateOnce, PANE_VIEW, useChat } from "../composables/chat/useChat";
import { CHAT_SURFACE } from "./chatSurface";
import { workspaceSurface } from "./workspaceSurface";
import { usePersonas } from "../composables/sandbox/usePersonas";
import { useRole } from "../composables/sandbox/useRole";
import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import { useChatAttachments } from "../composables/chat/useChatAttachments";
import { useComposerVoice } from "../composables/chat/useComposerVoice";
import { useEditorContextChip } from "../composables/chat/useEditorContextChip";
import { useRunThrough } from "../composables/chat/useRunThrough";
import { useStickToBottom } from "../composables/chat/useStickToBottom";
import { useTranscriptWarmup } from "../composables/chat/useTranscriptWarmup";
import { isBlocked } from "../composables/sandbox/connection";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { inputHistoryFor, recallStep } from "../composables/chat/inputHistory";
import { insertMention, mentionQueryAt } from "../composables/chat/useMentions";
import ChatCommandPopover from "./ChatCommandPopover.vue";
import ChatContinueStrip from "./ChatContinueStrip.vue";
import ChatImageThumb from "./ChatImageThumb.vue";
import ChatMentionPopover from "./ChatMentionPopover.vue";
import ChatForkCut from "./ChatForkCut.vue";
import ChatForkLine from "./ChatForkLine.vue";
import ChatMessageView from "./ChatMessageView.vue";
import ChatModelPicker from "./ChatModelPicker.vue";
import { useRunners } from "../composables/sandbox/useRunners";
import ChatModeMenu from "./ChatModeMenu.vue";
import ChatPlacementMenu from "./ChatPlacementMenu.vue";
import ChatPaneNotices from "./ChatPaneNotices.vue";
import ChatPaneStatus from "./ChatPaneStatus.vue";
import ChatPersonaMenu from "./ChatPersonaMenu.vue";
import ChatRunThroughMenu from "./ChatRunThroughMenu.vue";
import ChatTranscriptSkeleton from "./ChatTranscriptSkeleton.vue";
import ComposerEffort from "./ComposerEffort.vue";
import ComposerModelPill from "./ComposerModelPill.vue";
import ComposerMoreMenu from "./ComposerMoreMenu.vue";
import ComposerTierChip from "./ComposerTierChip.vue";
import { type ComposerControl, overflowRows, ridesRow } from "./composerMore";
import { startingMode } from "../composables/chat/turnDefaults";

/* ONE CHAT ON SCREEN: the transcript, the composer that writes into it, and the pickers and banners that
 * belong to that one conversation. The panel around it (ChatPanel) owns the frame: the chat list, the pop-out,
 * the resize handle, the shell-wide commands. Several of these stand side by side in a floating window.
 *
 * IT TAKES ITS CONVERSATION RATHER THAN READING THE FOCUSED ONE, which is the whole reason it is a component:
 * every value on screen here: what the composer sends, which model the pill names, whose plan the card
 * approves: has to be this pane's, not whichever chat happens to hold the focus. The facade over it
 * (conversationView) is built once here and PROVIDED, so the transcript rows and their tool cards four levels
 * down answer for the same chat without threading a prop through everything in between.
 *
 * WHAT THIS FILE IS, after everything that could be lifted out of it has been. The pane is wiring: it holds the
 * conversation, the transcript's shape, and the keyboard, and it delegates the four things that are their own
 * machine. What the next press MEANS and what to say about it is one decision table (composerIntent.ts); the
 * mic, the staged files, the run-through badge and the scroll warm-up are composables beside it; the standing
 * banners and the status readouts are components of their own (ChatPaneNotices, ChatPaneStatus). Anything that
 * can be decided from values alone belongs in the first of those, where it can be read as a table and tested
 * without a chat on screen.
 *
 * The column is a @container: composer/status label density keys off the width the messages get (288px docked
 * while the viewport is desktop-wide, or this pane's share of the floating window), while touch-target sizing
 * keys off the max-md: device class. Two intentional axes, don't unify them. */

const props = defineProps<{
    conversation: Conversation;
    // Whether this is the pane the keyboard is acting on. Only the focused pane answers the shell's "put the
    // caret in the composer" signal: with several panes open, every one of them answering would move the
    // caret to whichever mounted last.
    focused: boolean;
    // Whether this pane's column can be given back: true in a split, where taking one column back still
    // leaves a panel. The panel decides it (ChatPanel), because it is a fact about the set, not about this chat.
    closable: boolean;
}>();

/* THE TYPEWRITER IS THIS PANE'S, and only the focused pane runs one (TranscriptClock.watched). Written as an
 * effect rather than at mount, since a pane's conversation and its focus both move under it: a chat handed a
 * column of its own must stop typing in the one it left, or it goes on animating where nobody is looking for
 * the rest of the session. The chat left behind is settled explicitly for the same reason. */
watch(
    [() => props.conversation, () => props.focused],
    ([chat, focused], previous) => {
        const left = previous?.[0];
        if (left !== undefined && left !== chat) {
            left.watched.value = false;
        }
        chat.watched.value = focused;
    },
    { immediate: true },
);
// ...and a pane that goes away (a split closed, the panel docked) leaves nothing claiming to be watched.
onBeforeUnmount(() => (props.conversation.watched.value = false));

// Working in a pane is what focuses it: a click anywhere in it, or the caret arriving by any other route
// (Tab, a picker closing). The panel answers by moving the focus, which is a store write, so it is only
// raised by a pane that does not already hold it: every click in the focused pane would otherwise re-seat a
// focus that had not moved and scroll the rail to it.
const emit = defineEmits<{ focus: []; close: [] }>();
const takeFocus = (): void => {
    if (!props.focused) {
        emit(`focus`);
    }
};

// The corner ×, and what it is careful to say: this ends the COLUMN, not the conversation, the chat is still
// in the rail, one click from a column again. The chord it duplicates (chat.closePane) acts on the FOCUSED
// pane, so only the focused pane's button teaches it; on any other, naming a key that would close a different
// column is worse than naming none.
const CLOSE_PANE = `Close this pane: the chat stays open`;
const closeHint = computed(() => (props.focused ? withShortcut(CLOSE_PANE, `chat.closePane`) : CLOSE_PANE));

// The prop as a ref, for the view and the composables that follow this pane from one chat to the next.
const chat = computed(() => props.conversation);
const paneView = conversationView(chat);
provide(PANE_VIEW, paneView);
const {
    messages,
    streaming,
    awaitingDecision,
    pendingPlanMessage,
    pickUp,
    continuation,
    continueTurn: continueChat,
    mode,
    provider,
    model,
    draft,
    attachments,
    connected,
    queued,
    removeQueued,
    steerable,
    send,
    stop,
    decidePlan,
    availableCommands,
    editing,
    cancelEdit,
    submitEdit,
    forkAt,
} = paneView;
// The shell-wide signals the composer answers, and the only things this pane reads off the store rather than
// off its own conversation.
const { composerFocus } = useChat();
const router = useRouter();
/* What this pane's tool cards can lead to (chatSurface.ts). Per-PANE, like the view above it: with two chats
 * side by side, each card must offer its own chat's shell and browser rather than the focused chat's. */
provide(
    CHAT_SURFACE,
    workspaceSurface({
        agent: () => (props.conversation.isolated.value ? props.conversation.conversationId : undefined),
        terminal: () => props.conversation.agentTerminal.value,
        browser: () => props.conversation.agentBrowser.value,
        /* Every destination a card offers is an APP view (a browser session, a subagent's transcript), and a
         * popped-out chat is a window with no app in it: navigating there would replace the chat the reader is
         * in. So out there the destination is handed to the app's own window, exactly as a file reference is
         * (composables/mainWindow.ts); docked, this window IS that window and the push is the whole of it. */
        navigate: (route) => navigateInApp(router, route),
    }),
);
const { activeSandboxId, reachable, connection } = useSandbox();
// The daemon refused this Google account outright: a different sentence than "not connected yet", because
// waiting will not fix it.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
const blocked = computed(() => connection.value.failure !== undefined && isBlocked(connection.value.failure));
const { mobile } = useDevice();

/* Pill labels: rendered as our own text (not a PrimeVue Select); always a real model name. The option
 * catalogs live in the contract's agent-catalog.ts (shared with the automations dialog) and chat/catalog.ts.
 *
 * `providerDisplayLabel`, not the static one: a capability-derived provider has no row in the static table, so
 * the static label falls through to the RAW ID, which is how a chat on the free trial invited the user to
 * "Ask endpoint/free-trial…". The display label is the one every other surface already reads. */
const providerName = computed(() => providerDisplayLabel(provider.value));
// The chip's model name: shared with the picker menu so they can't drift; falls back to the provider name (never
// blank) while Grok's daemon catalog is still loading.
const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));
// The trial has no vendor to name: it is the product's own channel, and "Ask Free trial…" invites a sentence
// to a thing rather than to somebody.
const onTrial = computed(() => isTrialProvider(provider.value));
/* NEITHER PILL CARRIES A HOVER LABEL. The model pill's said the provider's name, which its own logo is
 * already there to say, and the mode pill's said the mode's description, which the menu one click below
 * prints under every mode including the one in force. Two boxes that opened over the composer to repeat what
 * was under them, on the two controls a hand rests on most while writing.
 * What the model's hint alone could say is gone with it: a turn RUNNING a different model than the one
 * selected (a fallback, or a provider alias) had no other home. That belongs on the turn, not on a hover of a
 * control that describes the NEXT one. */
const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
// The pickers: ONE open flag per menu, whichever surface renders it, an anchored panel on desktop, a bottom
// sheet on mobile, which ResponsiveOverlay picks between. One flag, not one per surface: the pair drifted apart
// once already, with the close-on-disconnect watch below reaching only the desktop half. The PILL is what says
// which window a desktop panel opens in: it is the anchor, and the overlay derives the document, the viewport
// it measures against and the dismissal listeners from it. That is the whole reason this panel can be popped
// out into a real window and still have overlays that land in the right place and close when clicked away from.
const modelOpen = ref(false);
const modeOpen = ref(false);
const personaOpen = ref(false);
const placementOpen = ref(false);
const moreOpen = ref(false);
const modelPill = ref<InstanceType<typeof ComposerModelPill>>();
const modePill = ref<HTMLElement>();
const placementPill = ref<HTMLElement>();
const runThroughPill = ref<HTMLElement>();
const personaPill = ref<HTMLElement>();
// The overflow's button, and the anchor THREE of the pickers above fall back to: a control sitting at its
// default has no chip in the row to hang its panel off, so the panel opens over the button it was reached from.
const morePill = ref<HTMLElement>();

// Auto-follow: the transcript stays at its newest content unless the user has scrolled up to read. The rule
// and every geometry change it has to survive live in the composable; the pane only says when a NEW transcript
// is on screen (the conversationId watch below) and when the user has just sent something (submit).
const { pin, follow } = useStickToBottom(scroller, content);

const activeError = computed(() => props.conversation.error.value);
/* This conversation's transcript round-trip, still in flight with nothing painted yet: the empty state
 * defers to a loading one on it. Gated by useLoadingReveal, not read raw: a warm daemon answers this in well
 * under the time it takes to read a placeholder, and an outline that appears for one beat and vanishes is a
 * glitch, not feedback. Keyed on the conversation so switching tabs mid-load drops the outline at once instead
 * of holding it over a different chat. */
const activeLoading = useLoadingReveal(
    computed(() => props.conversation.loading.value),
    computed(() => props.conversation.conversationId),
);

const { agentById } = useAgents();

/* THE PANE FOLLOWS THE FLEET: the missing half of "the chats fill a second later" (chatRun's promise about a
 * workflow's derived conversation ids). A run's panes open on conversations the daemon has not created yet,
 * and every read such a tab makes is one-shot: the transcript fetch 404s, the attach probe finds no run, and
 * nothing ever asks again, so a pane that lost that race stayed blank while the daemon streamed the whole
 * step into a record nobody re-read. The roster rides the /events stream, so it answers in real time what the
 * one-shot reads cannot: this conversation now exists, its turn began, its turn settled. Any change in that
 * answer, for a pane that is not itself streaming, means the daemon knows something this tab does not: bring
 * the tab up to date (hydrate attaches to a live turn and reconciles a settled one against the record).
 *
 * Primitive-valued, so the roster's full-snapshot republishing only fires the watch on an actual transition.
 * `undefined` (not on the roster) changes nothing a read could improve and touches nothing: an agent swept off
 * the roster is still an agent, and a pane must not react to the sweep. */
const fleetTurn = computed<boolean | undefined>(() => {
    const agent = agentById(props.conversation.conversationId);
    return agent === undefined ? undefined : turnInFlight(agent);
});
// Whether this tab itself streamed the turn the roster will settle next: its transcript already holds the
// result then, and reconciling against the record would only repaint what is on screen.
let streamedTurn = false;
watch(streaming, (live) => {
    if (live) {
        streamedTurn = true;
    }
});
watch(fleetTurn, (now, before) => {
    if (before === true && now === false && streamedTurn) {
        streamedTurn = false;
        return;
    }
    if (now === undefined || streaming.value) {
        return;
    }
    if (now) {
        // A turn this tab is not streaming just began: whatever the flag remembers is about an older one.
        streamedTurn = false;
    }
    // The roster listing this conversation IS the registration fact: heal a tab whose early probe took the
    // daemon's "unknown agent" for a final answer (replayStoredSession's unlatch), asked before the run's
    // first turn created the entry.
    props.conversation.registered.value = true;
    hydrateOnce(props.conversation);
});

// True for the assistant turn currently being streamed: the last assistant bubble while streaming. Not simply
// the last message: a notice this window wrote (a control action, a provider switch) sits below the bubble the
// turn is still writing into.
const isStreaming = (message: ChatMessage): boolean =>
    streaming.value && message.role === `assistant` && messages.value.findLast((entry) => entry.role === `assistant`)?.id === message.id;

// The transcript as prompt-headed groups. Each group is the box its own prompt is sticky WITHIN (see
// .chat-prompt), which is what ends the pin where the answer ends: rendered flat, every prompt would pin to
// the same top edge and pile up on the one before it. Recomputed per streamed frame like the list it replaces,
// and just as shallow: one pass, no message read beyond its role.
const turns = computed(() => turnsOf(messages.value));

/* THE TRANSCRIPT'S DATE: a day named above the first turn sent on it, and nowhere else (dayMarksOf).
 *
 * A chat is read over days and reopened weeks later, and until now the only place a date appeared at all was
 * inside a per-prompt label nobody sees without hovering the right bubble: "what did I ask on Tuesday" meant
 * hunting with the pointer. One marker per change of day answers it for a whole stretch of turns at once, costs
 * a thin row per day rather than per message, and is what lets each prompt's own stamp shrink to the clock
 * alone (see ChatMessageView's sentClock). */
const dayMarks = computed(() => dayMarksOf(turns.value));

/* WHAT A FORK BELOW EACH TURN INHERITS: the number that turn's mark hands the daemon (forkCutsOf), and the one
 * thing the grouped render has thrown away: a section knows its messages, not where they sit in the flat list.
 *
 * Built as one index rather than searched per turn: `turns` is rebuilt on every paint of a streaming answer, so
 * a findIndex per section would be quadratic in the transcript on every frame: the cost this file's v-memo
 * note is about, arriving by a different road. */
const forkCuts = computed(() => forkCutsOf(turns.value));

/* AND THE BOUNDARIES THAT INDEX DOES NOT COVER, keyed by the message each sits above (cutsAboveOf): the
 * messages a turn folded, and the conversation's first. One mark per turn is one boundary per turn, and a turn
 * holding a "keep going" or an errand holds more than one place a reader can want to go back to.
 *
 * Built here beside `forkCuts` and for the same reason: the flat position of a message is exactly what the
 * grouped render throws away, and asking per row would be a findIndex per row on every paint of a streaming
 * answer. */
const cutsAbove = computed(() => cutsAboveOf(turns.value));

/* WHAT AN EDIT IN PROGRESS WOULD THROW AWAY: the id of every row from the edited message down, so the
 * transcript can draw them as already gone while they are still entirely there.
 *
 * THIS IS THE HALF THAT MAKES THE MODE HONEST. An edit is the one gesture here that destroys turns without the
 * user naming a number: they click a pencil three prompts up and the cost is however much has happened since,
 * which is exactly the quantity nobody holds in their head. Rewind answers this with an arming step that
 * counts the messages in a menu row; an edit cannot borrow that, because the count has to stay legible for as
 * long as it takes to type a new prompt, so it is shown on the messages THEMSELVES, and stays shown until the
 * send or the cancel. Nothing is dropped to draw this; the rows are struck, not removed.
 *
 * A set of ids rather than an index, because it is read per row by a component that knows its message and not
 * its position, and because the id survives the reducer rebuilding `turns` under a streaming turn, which an
 * index would not. Empty whenever nothing is being edited, which is the ordinary case and costs one compare. */
const doomed = computed<ReadonlySet<number>>(() => {
    const target = editing.value;
    if (target === undefined) {
        return new Set();
    }
    const from = messages.value.indexOf(target);
    return from < 0 ? new Set() : new Set(messages.value.slice(from).map((message) => message.id));
});

// How many bubbles the armed edit would take with it, the edited prompt included: the number the Send names
// and the strip counts. Derived from `doomed` rather than counted again, so the strip can never disagree with
// what the transcript has struck through.
const editDropped = computed(() => doomed.value.size);

/* KEEP BOTH INSTEAD: the fork, offered from inside the edit, at the one moment it is most wanted and least
 * reachable: half-way through retyping the prompt, having just read the answer they are about to throw away
 * and thought better of it. The alternative is cancel, hunt for the mark in the margin at the end of that
 * answer, fork, and type the whole thing again from memory, which is enough friction that the honest
 * prediction is they simply spend the answer instead.
 *
 * It forks at the SAME cut the edit was aimed at, so the new tab inherits everything above the edited prompt
 * and opens with that prompt in its composer (see forkAt), where this pane's half-written replacement then
 * replaces it. Nothing is dropped here and nothing is sent: the source keeps its turns, the fork carries the
 * words, and the user is left in the new tab exactly where they were in this one.
 *
 * `now` and not `then`, deliberately, because this is the escape hatch from a DESTRUCTIVE act and it must not
 * be destructive itself: the files-as-they-were fork turns the new chat isolated and demands the source be
 * settled, which are two more conditions to explain in a strip that exists to be pressed without thinking. The
 * full three-way choice is where it always was, on the mark at the end of the answer. */
const forkInsteadOfEdit = (): void => {
    const target = editing.value;
    if (target === undefined) {
        return;
    }
    const cut = messages.value.indexOf(target);
    if (cut < 0) {
        return;
    }
    const carried = draft.value;
    const staged = attachments.value;
    // Ends the edit first, which puts THIS pane's composer back to whatever the pencil displaced: the fork
    // gets the words, and the tab being left behind is returned to the state it was in before any of this.
    cancelEdit();
    const fork = forkAt(cut, `now`);
    // The fork opens holding the ORIGINAL prompt (forkAt seeds it from the cut). What the user has actually
    // been typing is the replacement, so it wins: the whole reason to reach for this instead of cancelling is
    // that the half-written words are worth keeping.
    if (fork !== undefined) {
        fork.draft.value = carried;
        fork.attachments.value = [...staged];
    }
};

// --- Composer --------------------------------------------------------------------------------
const modeLabel = computed(() => modeMeta(mode.value).label);
const modeIcon = computed(() => modeMeta(mode.value).icon);

/* Size to content up to the max-height; `growTextarea` owns how, including the one-line floor THIS PANE is the
 * reason for. Every caller below fires on something the pane just did, a tab switch, a send, an account
 * connecting, and lands on `nextTick` or a post-flush watch, which guarantees the DOM is updated and
 * guarantees nothing about the box being laid out and styled yet. Believing that measurement left a composer
 * permanently the height of its own padding with the placeholder sliced through the middle: worst in a
 * floating window, where the panel is measured in the window it left and dressed in the one it arrived in, so
 * nothing this pane does ever re-measures it. */
const MAX_COMPOSER_HEIGHT = 192;
const grow = (): void => {
    growTextarea(input.value, MAX_COMPOSER_HEIGHT);
};

/* WHERE THIS CONVERSATION LIVES, and everything that follows from it being somewhere else.
 *
 * `box` is undefined for the overwhelming majority of chats: the sandbox this browser is pointed at. When it
 * names another one (the placement picker's "Other sandboxes"), the turn runs on THAT daemon and this pane is
 * one of its renderers, which is the same relationship every window already has to a detached run: the only
 * thing that changed is which machine it is detached on.
 *
 * What the pane does with it is refuse to offer the things that are about THIS machine, since they would name
 * files, accounts and personas the other daemon has never heard of. Each refusal is at its own control, with
 * the reason, rather than as one banner over a composer that then half-works. */
const conversationBox = computed(() => chat.value.box.value);
const remote = computed(() => conversationBox.value !== undefined);
// The name to put on it, from the roster rather than copied onto the conversation: the box's name is the box's
// to change, and a chat holding its own copy would go stale the moment somebody renamed it.
const remoteName = computed(() => (conversationBox.value === undefined ? undefined : (boxNameOf.value.get(conversationBox.value) ?? `another sandbox`)));

// Files staged for the next turn, and the three ways they arrive (useChatAttachments). The bytes go to the
// conversation's own box: the path they land on is what the prompt will tell that daemon to read.
const staging = useChatAttachments({ attachments, reachable, connected, at: conversationBox });
const { dragDepth } = staging;

// The chip that offers the file the user is looking at (useEditorContextChip)…
const { target: editorTarget, include: includeEditorContext, label: editorChipLabel, forSend: editorContextForSend } = useEditorContextChip();
// …offered only for a conversation that runs where that file is. The send drops the field for a remote one
// anyway (turnRequest.ts), and a chip that can be pressed and then silently ignored is worse than no chip.
const editorChip = computed(() => editorTarget.value !== undefined && !remote.value);

// The composer Send is usable whenever there is something to send: text, a finished attachment, or a queued
// message waiting to go out, regardless of what the conversation is doing: a message written mid-turn is
// never refused, it is delivered into the running turn or queued behind it (see Conversation.enqueue). A
// pending plan is no exception: the typed text becomes revision feedback, and staged files ride along with it
// (Conversation.decidePlan), because a screenshot is the most natural way to say what a plan got wrong.
const staged = computed(() => draft.value.trim().length > 0 || attachments.value.length > 0);
/* --- The composer's VOICE: yours, or the agent's --------------------------------------------------
 * Armed, the next Send does not prompt anything: the words are PLACED into the transcript as an assistant
 * bubble, no turn, no reply, and the daemon retires the provider session so the next real turn re-reads the
 * record and takes the placed line as its own (agents.place). Per-pane and DISARMED BY A SEND, deliberately:
 * speaking as the agent is a deliberate act each time, and a mode that stayed armed would have the next
 * ordinary question land in the transcript as words the agent never said.
 *
 * Offered only where it can land: the route is keyed on the registry, so a draft chat that has never run a
 * turn has nowhere to place into: the pill appears with the first turn, like the agent itself does. */
const voiceAgent = ref(false);

/* WHERE THE NEXT AGENT RUNS: this sandbox, one of its runners, or ANOTHER SANDBOX on this account
 * (ChatPlacementMenu owns the three-way argument). The pill appears only when there is somewhere else to
 * choose, or when this conversation is already placed somewhere: a control whose only option is "here" is
 * noise in a row that is already dense, and a fresh account has neither a runner nor a second box.
 *
 * `scopeOffered` is the same test the board's scope control uses, deliberately: "is there a second connected
 * sandbox to be about" is one question, and two surfaces answering it apart is how they come to disagree. */
const { runners: pairedRunners } = useRunners();
const placementLabel = computed(() => remoteName.value ?? props.conversation.runner.value ?? `Here`);
const placementShown = computed(
    () => pairedRunners.value.length > 0 || scopeOffered.value || props.conversation.runner.value !== undefined || remote.value,
);
const placeable = computed(() => props.conversation.registered.value || agentById(props.conversation.conversationId) !== undefined);

// The badge that says what the next message is run THROUGH: a loop, a workflow, or nothing (useRunThrough).
const runThrough = useRunThrough(chat, { reachable, connected, staged, draft });
const {
    open: runThroughOpen,
    state: runThroughState,
    icon: runThroughIcon,
    name: runThroughName,
    hint: runThroughHint,
    label: runThroughLabel,
    workflow: pickedWorkflow,
    loop: pickedLoop,
    running: runningLoop,
    workflowFailure,
    loopFailure,
    pickLoop,
    pickWorkflow,
    manage: manageRunThrough,
    end: endLoop,
} = runThrough;

/* WHAT THE ROW SHOWS AND WHAT THE OVERFLOW HOLDS (composerMore.ts owns the rule; this is the reading of it).
 * Four controls answer to it: mode, persona, run-through and the agent voice. Each rides the row as a named
 * chip while it is set to anything but this chat's default and sits in the overflow as a labelled row while it
 * is not, so the row is a description of THIS chat rather than a list of everything the composer can do.
 *
 * Model, effort and placement are not on the list: they are the ones that stay whatever they are set to, which
 * is the user's own reading of what a composer is for. */
const controlSituation = computed(() => ({
    mode: mode.value,
    startingMode: startingMode(props.conversation.isolated.value),
    persona: props.conversation.actsAs.value,
    runThrough: runThroughState.value,
    voiceAgent: voiceAgent.value,
    personaOffered: !remote.value,
    voiceOffered: placeable.value,
}));
const inRow = computed(() => ridesRow(controlSituation.value));
const moreRows = computed(() => overflowRows(controlSituation.value));
// What is behind the button, said on the button: the one thing an overflow owes a reader before they press it.
const moreHint = computed(() => moreRows.value.map((row) => row.label).join(` · `));

/* Each picker opens over whichever element the user reached it from: its own chip when the control is set, the
 * overflow button when it is not. One flag either way, so nothing here can end up with a panel open over an
 * anchor that is no longer on screen. */
const modeAnchor = computed(() => (inRow.value.mode ? modePill.value : morePill.value));
const personaAnchor = computed(() => (inRow.value.persona ? personaPill.value : morePill.value));
const runThroughAnchor = computed(() => (inRow.value.runThrough ? runThroughPill.value : morePill.value));

/* A row in the overflow hands off to the control that owns the choice, rather than making it here. The panel is
 * closed FIRST and the next one opened in the same press: the overlay arms its dismissal on the open flag, after
 * this handler has run, so the pointerdown that got here can never reach the panel it is opening. The voice is
 * the one with nothing to pick, so its row is the press. */
const openFromMore = (control: ComposerControl): void => {
    moreOpen.value = false;
    if (control === `mode`) {
        modeOpen.value = true;
    } else if (control === `persona`) {
        personaOpen.value = true;
    } else if (control === `runThrough`) {
        runThroughOpen.value = true;
    } else {
        voiceAgent.value = true;
    }
};

/* NOTHING ELSE THAT REWRITES WHAT SEND MEANS SURVIVES AN EDIT BEING ARMED: the voice, and the run-through
 * badge's two picks. All three answer the same question the edit does ("what happens when I press send") with
 * answers that cannot both hold, and submit() has to pick one; every arrangement where the loser stays LIT is a
 * composer showing a promise it will not keep.
 *
 * THE EDIT WINS, in every direction, because it is the most specific act of the four: the user pointed at one
 * message in this transcript. The others are standing postures that cost a single click to put back, and
 * clearing them VISIBLY (the pill goes quiet, the badge goes neutral) is what makes the precedence something
 * the user sees rather than something they discover by pressing Send.
 *
 * Cleared here rather than by disabling the controls, which is also why the run-through badge's PRESS is left
 * alone: a running loop is stopped from that badge, and a disabled one would leave the loop no way out but the
 * fleet board. Its pick goes; its press stays. */
watch(editing, (armed) => {
    if (armed === undefined) {
        return;
    }
    voiceAgent.value = false;
    runThrough.clear();
});
// A workflow badge takes the composer over entirely: the message becomes a run's request, and an agent voice
// left armed under it would be a promise about a send that is no longer a message into this chat.
watch(pickedWorkflow, (picked) => {
    if (picked !== undefined) {
        voiceAgent.value = false;
    }
});
/* Close the model, mode and persona panels whenever the pill they hang off stops being usable, which happens
 * two ways. The pills live behind `v-if="connected"`, so switching to a disconnected provider unmounts the
 * anchor out from under an open panel; and a picked workflow greys them, which a panel already open would
 * happily go on ignoring: a tab switch is enough to land in that state, since the open flags belong to the pane
 * and the badge belongs to the conversation. Either way the answer is the same: the composer that owns them
 * closes them.
 *
 * The run-through panel is NOT in this list, and that is the point of it: it is the one control a picked
 * workflow leaves live, because it is the control holding the pick. Closing it on `!isConnected` would be
 * right, but the pick that lands there closes it already, and unpicking has to stay reachable. */
watch([connected, pickedWorkflow], ([isConnected, workflow]) => {
    if (!isConnected || workflow !== undefined) {
        modelOpen.value = false;
        modeOpen.value = false;
        personaOpen.value = false;
        // The overflow goes with them: everything left inside it is one of the three above, since the badge that
        // greyed them has promoted run-through out into the row.
        moreOpen.value = false;
    }
});

/* The composer's own clock, running ONLY while a pick-up is counting down to an instant it named (an allowance
 * reset, hours out). Nothing else here is time-dependent, and a chat whose last turn simply stopped never
 * starts it: the press works from the moment the strip appears. */
const paneNow = useNow(() => pickUp.value?.readyAt !== undefined);
/* WHAT THE NEXT PRESS MEANS: one snapshot of the composer, and every answer that follows from it. The ladder
 * itself is composerIntent.ts; what the pane owns is the reading of it, because these are the values only a
 * mounted chat has. */
const situation = computed<ComposerSituation>(() => ({
    staged: staged.value,
    attached: attachments.value.length > 0,
    uploading: attachments.value.some((entry) => entry.status === `uploading`),
    uploadFailed: attachments.value.some((entry) => entry.status === `failed`),
    voiceAgent: voiceAgent.value,
    editing: editing.value !== undefined,
    pendingPlan: pendingPlanMessage.value !== undefined,
    streaming: streaming.value,
    awaitingDecision: awaitingDecision.value,
    steerable: steerable.value,
    // The pick-up, already read against the clock: the pure ladder must not ask what time it is (see
    // PickUpSituation), and this is the one place that knows, because it is the one place that ticks.
    pickUp: pickUp.value === undefined ? undefined : { ready: pickUpReady(pickUp.value, paneNow.value) },
    queued: queued.value.length,
    connected: connected.value,
}));
const intent = computed(() => sendIntentOf(situation.value));
// Why Send is refusing, in the user's words: undefined when the press will land.
const refusal = computed(() => sendRefusal(situation.value));
// Two readings of one state: the strip says what happened (including while the press is still waiting on a
// reset), and the offer is the press and the Enter key, which are the same gesture and share one predicate.
const continueStrip = computed(() => continueVisible(situation.value));
const continueOffer = computed(() => continueOffered(situation.value));
const canSend = computed(() => sendable(situation.value, intent.value, refusal.value));
/* THE END OF THE ROW HOLDS ONE PRIMARY BUTTON, and mid-turn which one it is follows the box.
 *
 * Send survives a live turn because a message written mid-turn always has somewhere to go (it steers the turn
 * or queues behind it), but with NOTHING TYPED there is no such message: the button was a dead grey circle
 * sitting where the eye looks for the primary action, with the live Stop demoted to its left. So an empty box
 * mid-turn gives the slot to Stop, which is the only thing a user with nothing to say can want from this row,
 * and the first keystroke brings Send back with Stop stepping aside.
 *
 * `staged`, not `canSend`, deliberately: a send that is REFUSED with words in the box (an armed edit, an
 * attachment still climbing) keeps its greyed button, because the tooltip on it is the only place the reason
 * is written. An empty composer is the one state that explains itself. */
const sendShown = computed(() => !streaming.value || staged.value);
// Everything a press that spends the box needs to be true, in one name: the two intercepting intents (the
// agent's voice and an armed edit) return before `canSend` is ever consulted, and Enter arrives straight into
// submit() without passing the disabled Send button at all.
const readyToSend = computed(() => connected.value && staged.value && refusal.value === undefined);

const words = computed(() => ({ provider: providerName.value, onTrial: onTrial.value, editDropped: editDropped.value }));
// A viewer's composer is present but inert: the transcript is theirs to read, the send is not theirs to make
// (the daemon floors every turn route at collaborator). Disabled-with-a-reason over hidden: an input that
// vanished would read as broken, and the placeholder is where a composer explains itself.
const { canDrive } = useRole();
const composerPlaceholder = computed(() => (canDrive.value ? placeholderFor(intent.value, words.value) : VIEWER_PLACEHOLDER));
const sendHint = computed(() => {
    if (!reachable.value) {
        return `The sandbox is busy: keep typing; Send is available when it is ready.`;
    }
    return refusal.value ?? sendHintFor(intent.value, words.value);
});
// Stop is offered for every live turn, including one parked on a card: that state is the most common reason to
// want out (a permission the user won't grant, a plan they'd rather restate from scratch), and until now the
// card's own buttons were the only way forward. Name the consequence there: the parked request goes with it.
const stopLabel = computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`));
const stopHint = computed(() =>
    awaitingDecision.value ? `Stop the turn, discards the request above` : mobile.value ? stopLabel.value : `${stopLabel.value} (Esc)`,
);

// The one line under the queued stack: what will actually happen to those messages. A turn that can take
// mid-turn input has already been offered them (they are only sitting here because it is parked on a card),
// so the wait is the card; an unsteerable turn ends first; with nothing running the queue rides the next send.
const queuedHint = computed(() => {
    if (!streaming.value) {
        return `Sends with your next message`;
    }
    return awaitingDecision.value ? `Sends once you answer the request above` : `Sends when this turn ends`;
});

// The sandbox's message-recall ring (↑ / ↓ / Escape in the composer: see the Message recall section below).
// Resolved per active sandbox rather than held, so switching sandboxes switches rings.
const history = computed(() => (activeSandboxId.value === undefined ? undefined : inputHistoryFor(activeSandboxId.value)));

/* Make the press (see continueOffered). What it DOES is the conversation's call, not this view's: on an ending
 * whose turn the daemon still holds it re-runs that turn, and otherwise it sends the sentence the button shows.
 *
 * The ring only takes the second kind. A sent continuation is an ordinary message, typed by the button instead
 * of by hand, so ↑ brings it straight back for anyone who wants to continue with an instruction attached rather
 * than plain; a re-run said nothing, and putting a word in the ring that nobody sent would hand them a message
 * to re-send that had never been a message. Down here beside the ring rather than up with the offer, so it
 * reads after the thing it writes to. */
const continueTurn = (): void => {
    if (!reachable.value) {
        return;
    }
    void continueChat().then((sent) => {
        if (sent !== undefined) {
            history.value?.record(sent);
        }
    });
    pin();
};

// A tab or sandbox switch swaps the composer's draft out from under a half-finished recall: drop it on both
// the outgoing and incoming ring so ↓/Escape can never paste one tab's draft into another's composer.
watch([() => props.conversation, history], (_current, [, previousHistory]) => {
    previousHistory?.reset();
    history.value?.reset();
});

/* Whether this draft SENDS as a command, which is a different question from what the popover lists: the
 * picker matches the token being typed, this matches the whole first word against the published names. It is
 * the same call the daemon makes on arrival (agent-commands.ts): a leading `/` runs as a command only when
 * the first token names one, and anything else is prose that goes to the model as written.
 *
 * Only the true case is worth saying. The composer used to speak up for the false one: "No command matches"
 * while the caret sat in the first token, which put a warning over `/workspace` and then withdrew it the
 * moment the user typed a space and the message became the sentence it was always going to be. */
const commandRun = computed<AgentCommand | undefined>(() => {
    const text = draft.value.trimStart();
    if (!text.startsWith(`/`)) {
        return undefined;
    }
    const name = text.slice(1).split(/\s/, 1)[0] ?? ``;
    return availableCommands.value.find((command) => command.name === name);
});

/* WHO THIS CHAT IS WHEN IT REACHES THE OUTSIDE WORLD. The pick lives on the conversation (and rides every turn
 * it sends); what the pane adds is the card behind the id: the name on the pill, and the one state worth
 * interrupting for.
 *
 * The cards are read here rather than passed in because the answer is workspace-wide and cached: several panes
 * asking is one request. */
const { personas: personaCards, isConnected: personaSignedIn } = usePersonas();
const pickedPersona = computed(() => personaCards.value.find((persona) => persona.id === props.conversation.actsAs.value));
const personaName = computed(() => pickedPersona.value?.label ?? pickedPersona.value?.id ?? props.conversation.actsAs.value);

/* THE ONE PERSONA STATE THE COMPOSER INTERRUPTS FOR, and only ever a state the user cannot see from the pill.
 * A working persona says everything it needs to by being named on the pill; these two do not.
 *
 * The missing card is first and is a WARNING rather than an aside: a chat pinned to a persona this workspace no
 * longer has gets no accounts and no tools at all (the daemon fails closed on a name it cannot resolve), and
 * the pill alone would read as a perfectly ordinary pick. */
const personaNotice = computed<string | undefined>(() => {
    const pinned = props.conversation.actsAs.value;
    if (pinned === undefined) {
        return undefined;
    }
    if (pickedPersona.value === undefined) {
        return `This chat acts as "${pinned}", which no longer exists: it would reach no account and no tools. Pick another persona.`;
    }
    /* A CARD HOLDING NO ACCOUNTS IS NOT A NOTICE. It used to raise one: "can work but can't post", and that
     * is a strip above the composer, on every turn, about a state the user chose and can see: they named a
     * persona that has no accounts on it, which still bounds the turn and still says who is speaking. Nothing
     * is failing, so there is nothing to interrupt for. What remains below is the case where the user asked
     * for something the chat CANNOT do: an account that exists and is not signed in. */
    return pickedPersona.value.capabilities.length === 0 || pickedPersona.value.capabilities.some((held) => personaSignedIn(held))
        ? undefined
        : `${personaName.value} isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`;
});

/* Picking a persona no longer moves the chat between trees. A card used to be able to say "work in the SHARED
 * workspace" and this mirrored that onto `isolated` before the first turn; both halves are gone, because every
 * conversation already starts in its own copy and a card's job is to say where it starts and what it may touch,
 * not to undo the isolation that lets two of them run at once. */
const pickPersona = (id: string | undefined): void => {
    personaOpen.value = false;
    props.conversation.actsAs.value = id;
};

// Snap the box back to one line and keep the cursor ready for the next message: what every path that spends
// the draft ends with.
const settleComposer = (): void => {
    draft.value = ``;
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

/* Place the draft into the transcript as the AGENT's words (the armed voice above). Awaited rather than
 * fire-and-forget, unlike an ordinary send, because a refused place has no queue to fall back into: the words
 * either land in the record or they stay in the box, and clearing the draft on a refusal would be the composer
 * eating a message. The conversation's own error line names why the daemon said no. */
const placeDraft = async (): Promise<void> => {
    const text = draft.value.trim();
    if (!(await props.conversation.placeAsAgent(text))) {
        return;
    }
    // The warmed transcript cache now ends one row early: the same signal a settled turn sends.
    invalidateAgentTranscript(props.conversation.conversationId, props.conversation.box.value);
    history.value?.record(text);
    // Disarm: speaking as the agent is a deliberate act each time (see voiceAgent).
    voiceAgent.value = false;
    pin();
    settleComposer();
};

/* Rewind to the message being edited and send the box in its place (Conversation.submitEdit).
 *
 * THE SEND IS THE CONFIRMATION. Everything the edit destroys is destroyed here and nowhere earlier, which is
 * what buys the mode its cancel-costs-nothing promise, and why there is no second "are you sure" on top of it:
 * the user has just restated the prompt with the casualties struck through on screen in front of them. */
const sendEdit = (): void => {
    const replacement = draft.value.trim();
    void submitEdit(replacement, staging.snapshot(), editorContextForSend());
    attachments.value = [];
    includeEditorContext.value = false;
    history.value?.record(replacement);
    pin();
    settleComposer();
};

// The ordinary message: one path whether or not a turn is running, the conversation delivers it into the
// running turn or queues it (see Conversation.enqueue). Typing while a plan is pending rejects that plan with
// the text as feedback (Claude Code style) instead, and the agent stays in plan mode to revise.
const sendDraft = (): void => {
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    // Snapshot the chips onto the message, then clear WITHOUT revoking preview URLs: the thumbnails now live
    // on the queued/sent (or rejected-with-feedback) message, which owns them.
    if (pendingPlan !== undefined) {
        void decidePlan(pendingPlan, false, text, staging.snapshot());
        attachments.value = [];
    } else {
        void send(text, staging.snapshot(), editorContextForSend());
        attachments.value = [];
        includeEditorContext.value = false;
    }
    // Both branches send `text` somewhere (a turn, the queue, a plan revision), so both earn a slot in the
    // recall ring: except the bare "flush the queue" press, which contributed no text of its own.
    if (text.length > 0) {
        history.value?.record(text);
    }
    // Sending is a statement that the bottom is where the user now wants to be: they wrote the newest thing
    // in the transcript. It re-arms the follow they gave up by scrolling away to check something before
    // writing, which is the one case where the "leave the reader alone" rule would be reading the wrong intent.
    pin();
    settleComposer();
};

/* THE PRESS, in the precedence the intents are named in.
 *
 * The first two INTERCEPT: placed words are not a turn and an edit is not a new message at the end of the
 * conversation, so no gate below them: a plan to revise, a turn to steer, a queue to flush, a stopped turn to
 * continue: is asking about the right thing. Each returns either way, because falling through with an empty
 * box would let a press meant as "place" become a Continue, and a press meant as "replace that prompt" become
 * an ordinary send appended to the very turns the user was replacing.
 *
 * Then the badge, which is not a turn on this conversation at all (useRunThrough.claimSend). Then `canSend`,
 * which covers what is left: an empty composer, and an attachment that isn't on disk yet. */
const submit = (): void => {
    runThrough.clearFailures();
    if (!reachable.value) {
        return;
    }
    if (intent.value === `place`) {
        if (readyToSend.value) {
            void placeDraft();
        }
        return;
    }
    if (intent.value === `edit`) {
        if (readyToSend.value) {
            sendEdit();
        }
        return;
    }
    if (runThrough.claimSend()) {
        return;
    }
    if (!connected.value || !canSend.value) {
        return;
    }
    /* NOTHING TYPED AND A TURN LEFT HANGING: the press means Continue (see continueOffered). Below the badges,
     * which are explicit choices the user armed, and above everything else, because every gate under here reads
     * the draft, and the whole point of this branch is that there isn't one. */
    if (continueOffer.value) {
        continueTurn();
        return;
    }
    sendDraft();
};

// Hands-free voice: the mic, and what the pause does (useComposerVoice). Below `submit`, because the pause IS
// the send: the countdown calls it.
const {
    on: voiceOn,
    live: voiceLive,
    state: voiceState,
    level: voiceLevel,
    buttonHint: voiceHint,
    slotHint: voiceSlotHint,
    errorMessage: voiceErrorMessage,
    toggle: toggleVoice,
    quit: quitVoice,
} = useComposerVoice({ draft, reachable, grew: grow, send: submit });
// Leaving exits hands-free: a mode that kept recording a pane the user walked away from would be the feature
// at its worst. The draft is untouched. (Typing exits it too, from the input handler below.)
watch([() => props.conversation, () => props.focused], quitVoice);

// The one hint slot under the composer. An empty box can't take a newline but CAN take a recall, so it
// advertises whichever of the two is live. Recomputed as the draft empties, which is exactly when a send has
// just filled the ring.
const recallable = computed(() => draft.value === `` && history.value?.recallable === true);
const composerHint = computed(() => {
    // The live voice mode outranks everything below: while it is on, Escape means "catch the mic", so the
    // streaming hint's "Esc to stop" would name the wrong action.
    const spoken = voiceSlotHint.value;
    if (spoken !== undefined) {
        return spoken;
    }
    // While the agent is generating, the shortcut worth the slot is the way out of it: the same slot is how
    // the user learns Escape does this at all.
    if (streaming.value && !awaitingDecision.value) {
        return `Esc to stop`;
    }
    // A draft that runs as a command sends nothing to the model, so say so before Enter rather than after.
    if (commandRun.value !== undefined) {
        return `Enter runs /${commandRun.value.name}`;
    }
    /* The stopped turn's shortcut, in the slot the user is already looking at while they decide what to type.
     * This is the whole of how anyone learns the key exists: the strip above says a turn is unfinished and
     * carries the button, and this says the key does the same thing, so the gesture is learned once, at the
     * only moment it applies, and costs the composer nothing on every other turn. Ahead of the recall hint
     * because it is the rarer state and the more useful one: ↑ is always there, and this is not. */
    if (continueOffer.value) {
        return `Enter to continue`;
    }
    return recallable.value ? `↑ for previous message` : `Shift+Enter for new line`;
});

// --- @-mention + /-command popovers -----------------------------------------------------------
// The caret drives which popover is live: an @-token at the caret opens the file picker; a leading `/` with
// the caret still inside the first token opens the provider's command list. Escape dismisses until the token
// changes.
const caret = ref(0);
const syncCaret = (): void => {
    caret.value = input.value?.selectionStart ?? draft.value.length;
};
const onInput = (): void => {
    grow();
    syncCaret();
    // Typing makes the text the user's own again: a recalled message they have started editing is a draft, so
    // the stashed one it displaced is no longer anyone's to restore. Only real keystrokes land here: the
    // programmatic draft writes (recall, mention/command picks, voice transcripts) go through v-model and fire
    // no input event, which is exactly what lets a keystroke mean "I'm taking over from the mic": it catches
    // the armed voice send and ends hands-free, with the words kept in the box.
    quitVoice();
    history.value?.reset();
};
const popoverDismissed = ref(false);
const activeMention = computed(() => mentionQueryAt(draft.value, caret.value));
const slashQuery = computed<string | undefined>(() => {
    if (availableCommands.value.length === 0 || !draft.value.startsWith(`/`)) {
        return undefined;
    }
    const upto = draft.value.slice(1, caret.value);
    return caret.value >= 1 && !/\s/.test(upto) ? upto : undefined;
});
watch([() => activeMention.value?.query, slashQuery], () => {
    popoverDismissed.value = false;
});
// Commands the token being typed could still become. Nothing to show is a closed popover, not an empty one
// saying so: see ChatCommandPopover's header for why that line was the wrong warning.
const commandMatches = computed<readonly AgentCommand[]>(() => {
    const needle = slashQuery.value?.toLowerCase();
    return needle === undefined ? [] : availableCommands.value.filter((command) => command.name.toLowerCase().includes(needle));
});
const mentionPopover = ref<InstanceType<typeof ChatMentionPopover>>();
const commandPopover = ref<InstanceType<typeof ChatCommandPopover>>();
/* NOT FOR A CONVERSATION THAT LIVES IN ANOTHER BOX. The popover completes against THIS workspace's file tree
 * (ChatMentionPopover's search is an active-sandbox read), and the paths it would offer are paths the daemon
 * being written to has never seen: an @-mention that resolves to nothing is a turn refused at the door, or
 * worse, a same-named file on the wrong machine. Typing `@` is then an ordinary character, which is the
 * correct amount of ceremony for a thing that cannot be answered here. */
const mentionOpen = computed(() => activeMention.value !== undefined && !popoverDismissed.value && !remote.value);
const commandOpen = computed(() => !mentionOpen.value && commandMatches.value.length > 0 && !popoverDismissed.value);

// Put the picked text into the draft and land the caret after it, keeping the textarea focused.
const applyDraftEdit = (text: string, nextCaret: number): void => {
    draft.value = text;
    void nextTick(() => {
        const el = input.value;
        if (el) {
            el.focus();
            el.setSelectionRange(nextCaret, nextCaret);
        }
        caret.value = nextCaret;
        grow();
    });
};

const pickMention = (path: string): void => {
    const mention = activeMention.value;
    if (mention === undefined) {
        return;
    }
    const result = insertMention(draft.value, mention, caret.value, path);
    applyDraftEdit(result.text, result.caret);
};

const pickCommand = (name: string): void => {
    const rest = draft.value.slice(caret.value);
    const inserted = `/${name} `;
    applyDraftEdit(`${inserted}${rest.startsWith(` `) ? rest.slice(1) : rest}`, inserted.length);
};

// --- Message recall --------------------------------------------------------------------------
// Put a recalled message in the composer with the caret at its end, ready to send or edit.
const recallInto = (text: string): void => {
    applyDraftEdit(text, text.length);
    // A recalled message is complete: a leading `/` or an @-path in it must not pop an autocomplete list open
    // over it. Dismissed on the next tick, after the query watch above has re-armed on the new draft.
    void nextTick(() => {
        popoverDismissed.value = true;
    });
};

// Returns true when recall consumed the key: see recallStep for which presses it claims and which walk the
// caret to the edge of a wrapped line first. Nothing is claimed while text is selected: there the arrows are
// collapsing a selection, not navigating. The live element is read rather than the `caret` ref, which only
// tracks keyup/click and so goes stale under an auto-repeating arrow: exactly the case that decides when the
// caret reaches the edge.
const recallKeydown = (event: KeyboardEvent): boolean => {
    const past = history.value;
    const el = input.value;
    if (past === undefined || el === undefined || el.selectionStart !== el.selectionEnd) {
        return false;
    }
    const step = recallStep(past, event.key, draft.value, el.selectionStart);
    if (step === undefined) {
        return false;
    }
    event.preventDefault();
    if (step.kind === `text`) {
        recallInto(step.text);
        return true;
    }
    el.setSelectionRange(step.at, step.at);
    caret.value = step.at;
    // The step always lands on an edge of the draft, which past max-h-48 is scrolled out of view, and moving a
    // textarea's selection does not reliably bring it back. Without this the caret would leave the visible rows
    // and the press would read as having done nothing.
    el.scrollTop = step.at === 0 ? 0 : el.scrollHeight;
    return true;
};

// --- The composer's keyboard ------------------------------------------------------------------
// Both lists answer the same three gestures, and the composer wants nothing else from either.
interface PopoverList {
    readonly move: (delta: number) => void;
    /** Whether a row was actually picked: with none active, the key belongs to the composer. */
    readonly pickActive: () => boolean;
}
const activePopover = computed<PopoverList | undefined>(() =>
    mentionOpen.value ? mentionPopover.value : commandOpen.value ? commandPopover.value : undefined,
);
// An open popover owns the list keys; anything it does not claim falls straight through, which is what keeps
// Shift+Enter a newline with the list up.
const POPOVER_KEYS: Record<string, (popover: PopoverList, event: KeyboardEvent) => boolean> = {
    ArrowDown: (popover) => {
        popover.move(1);
        return true;
    },
    ArrowUp: (popover) => {
        popover.move(-1);
        return true;
    },
    Escape: () => {
        popoverDismissed.value = true;
        return true;
    },
    Enter: (popover, event) => !event.shiftKey && popover.pickActive(),
    Tab: (popover) => popover.pickActive(),
};
const popoverKeydown = (event: KeyboardEvent): boolean => {
    const popover = activePopover.value;
    if (popover === undefined) {
        return false;
    }
    return POPOVER_KEYS[event.key]?.(popover, event) === true;
};

// Escape interrupts the turn (Claude Code's shortcut), but only while it is GENERATING: a turn parked on a card
// is spending nothing, and losing a plan the user is still reading to a stray Escape costs far more than the
// keystroke saves: the Stop button is the deliberate way out of that one.
const interruptible = computed(() => streaming.value && !awaitingDecision.value && reachable.value);
/* WHO GETS ESCAPE, once the popovers and message recall have had their claim on it. Both modes above the
 * turn-stop are there on the same reasoning: the thing the user is escaping is the mode they are in, and
 * stopping a streaming turn instead would be a far bigger action than the key meant.
 *
 * The voice catches a message counting down to send (the words stay in the box for editing) and ends hands-free
 * either way. The edit is simply abandoned, which is free: the transcript is intact, the files are untouched,
 * and the composer goes back to whatever the pencil displaced (Conversation.cancelEdit). */
const escapeKeydown = (): boolean => {
    if (voiceLive.value) {
        quitVoice();
        return true;
    }
    if (editing.value !== undefined) {
        cancelEdit();
        return true;
    }
    if (!interruptible.value) {
        return false;
    }
    stop();
    return true;
};

const onKeydown = (event: KeyboardEvent): void => {
    // Never submit mid-IME-composition (CJK candidates confirm with Enter).
    if (event.isComposing) {
        return;
    }
    if (popoverKeydown(event)) {
        event.preventDefault();
        return;
    }
    // After the popovers: an open @/-list owns the arrows for the token being typed, and recall's own Escape
    // must not pre-empt dismissing that list. Recall claims the key by preventing the default itself.
    if (recallKeydown(event)) {
        return;
    }
    if (event.key === `Escape`) {
        if (escapeKeydown()) {
            event.preventDefault();
        }
        return;
    }
    // On mobile Enter is a newline (the send button submits): the virtual keyboard has no Shift+Enter.
    if (event.key !== `Enter` || mobile.value) {
        return;
    }
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline.
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
        return;
    }
    event.preventDefault();
    submit();
};

// --- Tabs / history --------------------------------------------------------------------------
// This pane's half of "New agent" (and of anything else that hands the user the composer): the action itself
// lives in agentActions.startAgent, which opens the tab wherever it was pressed: the board, the strip's "+",
// the mobile header, and then asks for the caret. A composer is the only thing that can give it, so the pane
// answers the signal, and every surface gets the same result instead of the one that happens to sit next to
// the textarea getting a better one. Only the FOCUSED pane answers: the signal names no conversation, and the
// tab it was raised for is the one that just took the focus. The scroller needs nothing here: a new tab is a
// new conversation, and the watch below pins on that.
watch(composerFocus, () => {
    if (!props.focused) {
        return;
    }
    void nextTick(() => {
        grow();
        const field = input.value;
        field?.focus();
        // A composer that arrives ALREADY FILLED: a board starter's suggestion, deliberately left mid-sentence
        // where the repository goes: has to leave the caret where the sentence stops rather than in front of
        // it. A no-op on the empty draft every other summons focuses.
        field?.setSelectionRange(field.value.length, field.value.length);
    });
});

// --- Lifecycle / effects ---------------------------------------------------------------------
// One idle-time realization pass after a transcript lands wholesale, so the native scrollbar stops lying about
// how tall the column is (useTranscriptWarmup).
const { realizing } = useTranscriptWarmup({
    conversationId: computed(() => props.conversation.conversationId),
    messageCount: computed(() => messages.value.length),
    streaming,
});

/* A different transcript is on screen: start it at its newest message, the way a chat is opened everywhere.
 *
 * This is the ONE place that says so, and it is the state itself rather than any of the presses that reach it:
 * the strip's tabs and history menu, the agents board opening a card, /agents/:id, the review panel, a closed
 * tab handing focus to its neighbour. Half of those don't know this pane exists, which is exactly how the
 * bug this replaces worked, since each of them had to remember to re-pin and only three did. Post-flush so the
 * new transcript is in the DOM to be scrolled; what arrives later (a hydrate, the cached repaint, an attached
 * live turn) grows the transcript, and the pin follows growth on its own.
 *
 * A tab switch also swaps a possibly multi-line draft under the textarea: re-size the box to the new one. */
watch(
    () => props.conversation.conversationId,
    () => {
        pin();
        grow();
    },
    { flush: `post` },
);

/* The transcript changed: follow it, if the reader has not scrolled up.
 *
 * The composable's observers say "these boxes are a different size now", which is a measurement, taken in a
 * frame, and delivered in one: a notification the browser coalesces or defers past the layout that produced it
 * (a resize-observer loop that hits its depth limit does precisely this, and a transcript of
 * content-visibility rows realizing under a scroll write is how you get there) leaves the newest content below
 * the fold with nothing to bring it up. That was this bug: the message went out, "Perusing…" was appended
 * under the composer, and the panel sat exactly where it was.
 *
 * So the pane states the fact it holds directly, in terms no frame can lose: a message arrived or left, and a
 * turn started or ended, which is the loader, the one thing a send puts on screen before the answer exists.
 * O(1) per flush and post-flush, so the row is in the DOM to be scrolled to; a streamed frame appends text to
 * a bubble that is already counted, and stays the observers' job. */
watch([() => messages.value.length, streaming], follow, { flush: `post` });

// Drop focus into the composer as soon as the account connects; grow sizes the box to a restored draft (the
// textarea mounts with the persisted text already in it). Not on mobile: autofocus there pops the keyboard
// over half the transcript before the user asked for it, and not in an unfocused pane, which would steal the
// caret out of the one the user is typing in.
watch(
    connected,
    (isConnected) => {
        if (isConnected) {
            void nextTick(() => {
                grow();
                if (!mobile.value && props.focused) {
                    input.value?.focus();
                }
            });
        }
    },
    { immediate: true },
);
</script>

<template>
    <!-- Everything the panel's chat list is NOT. It carries the @container, so the composer's density keys off
         the width left for the transcript rather than off the panel plus its rail, and with several panes
         open, off THIS pane's share of it. -->
    <div
        class="chat-pane @container relative flex min-h-0 min-w-0 flex-1 flex-col"
        :class="{ 'chat-pane-on': focused }"
        @pointerdown="takeFocus"
        @focusin="takeFocus"
        @dragenter="staging.onDragEnter"
        @dragover.prevent
        @dragleave="staging.onDragLeave"
        @drop.prevent.stop="staging.onDrop"
    >
        <div
            v-if="dragDepth > 0"
            class="pointer-events-none absolute inset-1 z-30 rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10"
        ></div>
        <!-- GIVING THIS COLUMN BACK. It floats over the transcript's top-right corner rather than sitting in a
             header, because a pane has no header: a bar per column would cost every pane a strip of height to
             carry one control, and the panel above already names the chats. Muted at rest so a permanent mark
             does not compete with the conversation, over its own faint backdrop so it stays legible against
             whatever scrolls under it (it clears the pinned prompt, which is opaque).
             Neither press moves the FOCUS: stopping pointerdown and focusin keeps closing a pane the user was
             not working in from flashing the focus accent onto a column that is about to disappear. -->
        <button
            v-if="closable"
            type="button"
            class="absolute top-2 right-2 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg bg-card/70 text-subtle backdrop-blur-sm transition-colors hover:bg-overlay hover:text-content"
            v-tooltip.bottom="closeHint"
            aria-label="Close pane"
            @pointerdown.stop
            @focusin.stop
            @click.stop="emit(`close`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
        <!-- ONE scroller for the transcript AND the composer under it, so the room the composer takes is
             reserved by the layout rather than measured back into it: the composer is the last thing in
             the scrolled content and sticks to the bottom edge, which means the transcript can always be
             read clear of it, by exactly as much as it happens to be tall (a five-line draft, attachment
             chips, the queued stack, a banner) and no more. Scrolled up, the messages pass under it: see
             the composer's own note.
             The inner wrapper is what the autoscroll ResizeObserver measures; the scroller itself never
             changes height, so it can't report either of them growing.
             The insets live in here rather than on the scroller: a sticky element resolves against the
             scroller's PADDING edge, so padding out there would leave a band above the pinned prompt (and
             below the composer) for the transcript to slide through. It also lets the composer be wider
             than the column of text, which a padding shared by both could not. -->
        <!-- .chat-scroller is the IntersectionObserver root each prompt uses to tell whether it is pinned.
             VERTICAL ONLY. This scroller holds the transcript AND the composer, so anything in either that
             happens to be wider than the column used to drag a sideways scrollbar across the entire panel:
             a chat that scrolls left and right is always a bug, and it announced itself as one at the size the
             docked column ships at. Nothing legitimately needs the axis: the composer's controls wrap now, and
             the two kinds of content that genuinely cannot be narrowed (code blocks and tables) carry their
             own scroller in prose.css, which is where that scroll belongs. -->
        <div
            ref="scroller"
            class="chat-scroller scrollbar-thin flex flex-1 flex-col overflow-x-hidden overflow-y-auto"
            :class="{ 'chat-realize': realizing }"
        >
            <div ref="content" class="flex min-w-0 flex-1 flex-col">
                <div class="chat-turns flex flex-1 flex-col pt-4">
                    <!-- Where a forked chat says so: above the turns it inherited, which without it read as
                         this conversation's own beginning. -->
                    <ChatForkLine />
                    <template v-if="messages.length > 0">
                        <!-- One section per turn, purely so each prompt's sticky range ends where its answer
                             does. A bare "continue" and an app errand both fold into the turn they serve
                             (see foldsIntoTurn), so the question that defines the work stays pinned through
                             the continued answer. -->
                        <!-- `index` is here for the day marker below, which is the one row that cares where it
                             stands in the column rather than which turn it belongs to. -->
                        <template v-for="(turn, index) in turns" :key="turn.id">
                            <!-- THE DAY THIS STRETCH OF THE CONVERSATION WAS SENT ON: drawn only where the date
                                 changes (dayMarks), so a chat written in one sitting carries exactly one and a
                                 chat picked up over a fortnight says so where it was picked up. Between the
                                 sections rather than inside one, because it is a boundary, not part of a turn.
                                 Bare centred text, no rule across the column: a line there fences the turns off
                                 from each other, which is the reason the old cut line between every two turns
                                 went (see ChatForkCut). Weighted above rather than below: the marker belongs to
                                 what follows it, and the extra air separates it from the answer it interrupts.
                                 The first row needs none of that air: the column's own top padding is already
                                 there. -->
                            <div
                                v-if="dayMarks.get(turn.id)"
                                class="flex justify-center pb-0.5 text-2xs text-subtle"
                                :class="index === 0 ? '' : 'pt-3'"
                            >
                                {{ dayMarks.get(turn.id) }}
                            </div>
                            <section class="chat-stack group/turn relative flex flex-col">
                                <!-- v-memo skips the vnode entirely for a row whose inputs are unchanged, which
                                     during a streaming turn is every row but the one being written: `turns` is
                                     rebuilt on each paint, so without it the whole transcript is re-created to
                                     redraw one bubble. The key lists exactly what the row renders from: a
                                     message keeps its identity through the reducer unless that message changed,
                                     and `folded` holds still per turn (see ChatTurn.folded). -->
                                <!-- `doomed` joins the memo key for the same reason every other input does: a
                                     row that has just been struck (or unstruck by a cancel) renders
                                     differently, and a memo that did not list it would leave the transcript
                                     showing the previous edit's casualties. -->
                                <!-- A `display: contents` wrapper, which is doing two jobs at once and neither is
                                     layout: its children ARE the section's flex items, spaced on the same gap,
                                     exactly as they were when the row was the loop's element.
                                     It exists because a row can now be preceded by a mark (cutsAbove) and
                                     because `v-memo` must sit on the same element as its `v-for` — that is the
                                     only arrangement Vue gives a per-iteration cache slot, and a memo on a child
                                     of the loop would share ONE slot across every row in the transcript.
                                     `cutAbove` joins the memo key like every other input: it moves whenever a row
                                     is added or dropped above this one, and a memo that did not list it would
                                     leave a mark pointing at the boundary it used to sit on. -->
                                <div
                                    v-for="message in turn.messages"
                                    :key="message.id"
                                    v-memo="[message, isStreaming(message), turn.folded, doomed.has(message.id), cutsAbove.get(message.id)]"
                                    class="contents"
                                >
                                    <!-- THE WAY BACK TO JUST ABOVE THIS MESSAGE, for the boundaries one mark per
                                         turn cannot reach: a message the turn folded (see cutsAboveOf).
                                         BETWEEN the rows rather than inside one, which is not a stylistic
                                         choice: `.chat-message` carries `content-visibility: auto`, and
                                         that paint-contains the row, so a mark hanging above its top edge is
                                         clipped out of existence — invisible AND unclickable. `.chat-prompt`
                                         happens to opt back out with `content-visibility: visible`, so drawn from
                                         inside the row it worked on opening prompts and silently vanished on
                                         every folded one, which is the worst of both. -->
                                    <ChatForkCut v-if="cutsAbove.get(message.id) !== undefined" :cut="cutsAbove.get(message.id)!" />
                                    <ChatMessageView
                                        :message="message"
                                        :streaming="isStreaming(message)"
                                        :folded="message.id === turn.id ? turn.folded : undefined"
                                        :doomed="doomed.has(message.id)"
                                    />
                                </div>
                                <!-- THE FORK POINT of this turn, in the column's MARGIN at the end of the answer:
                                     everything down to here is what a fork keeps, and everything after it is
                                     what it leaves behind. Last in the section so it stands level with the close
                                     of what was said rather than in the middle of it, and drawn inside the
                                     section so it hangs off the turn's own hover: a mark nobody is pointing at
                                     is invisible. It costs the transcript no height (see ChatForkCut). -->
                                <ChatForkCut :cut="forkCuts.get(turn.id) ?? messages.length" />
                            </section>
                        </template>
                    </template>
                    <!-- The transcript is on its way (a history open, a restored tab whose local mirror was
                         empty). Without this state the round-trip wears the "Start a conversation" text
                         below, which over a chat that merely hasn't arrived yet reads as data loss. -->
                    <ChatTranscriptSkeleton v-else-if="activeLoading" />
                    <!-- "Start a conversation with X" names the provider because on every other one that is the
                         fact worth having: whose model is about to answer. On the trial it is the wrong
                         sentence: the reader has connected nothing, so what they need to know is that this
                         works anyway, and naming a provider they never chose only raises a question. -->
                    <p v-else class="m-auto max-w-[80%] text-center text-xs text-muted">
                        {{ onTrial ? `Ask anything, this chat is free and needs nothing connected.` : `Start a conversation with ${providerName}.` }}
                    </p>
                    <p v-if="activeError" class="text-xs text-danger">{{ activeError }}</p>
                </div>

                <!-- The composer and the notices that gate it. A transiently busy sandbox disables live actions,
                     but leaves the draft mounted so the interruption cannot eat or discourage work in progress.
                     It is the LAST ROW OF THE TRANSCRIPT, stuck to the bottom edge, rather than a band beneath
                     it. In its own row it was panel background wrapped around the box, and that padding read as
                     chrome the composer was mounted on, which is what a chat's most-used control should least
                     look like. Here the only surface is the composer's own rounded box (and whichever banners
                     are up): the transcript runs to the bottom of the pane and, once the user scrolls up,
                     slides under a box with nothing but transparent padding around it. Parked at the bottom
                     there is nothing behind it to see, because being in the flow is what reserves its room.
                     .chat-footer hands pointer events in that transparent region back to the messages, and the
                     z-index clears .chat-prompt's: a pinned prompt is opaque, and in a pane short enough
                     (mobile with the keyboard up) it reaches this far down.
                     The box is a touch WIDER than the column of text it sits under (50rem against .chat-turns'
                     48rem, and a half-inset against its full one below either cap): a composer flush with the
                     prose reads as one more block of the transcript, and the reading measure is a rule for text,
                     not one the app's controls have to line up on. Capped at all for the floating window,
                     where a full-width composer is a 150-character line with its Send button half a screen from
                     the text. -->
                <div class="chat-footer sticky bottom-0 z-10 mx-auto flex w-full max-w-[51rem] flex-col gap-2 px-2 py-3">
                    <!-- THE TWO STATES WHERE THERE IS NO COMPOSER TO EXPLAIN ITSELF, and only those two. A
                         sandbox that is merely BUSY is not one of them: it says so once, in the app's
                         notification lane, and what this pane owed its reader was never a second copy of that
                         sentence in bare text above the box — it was why Send is dark, which is on Send
                         (`sendHint`). Saying it in both places is how the app came to have a floating pill and a
                         line of unstyled paragraph text making the same claim at the same moment.
                         In flow rather than floating: this is about THIS pane, and a pane with two chats beside
                         each other must be able to say it about one of them. -->
                    <Notice v-if="denied" tone="danger">This Google account has no access to this sandbox, so chat is unavailable.</Notice>
                    <Notice v-else-if="blocked" tone="info" icon="clock">Chat is available after this sandbox finishes setup.</Notice>
                    <template v-if="!blocked">
                        <!-- What this chat's standing is: archived, the account gate, the trial, a credential
                             that needs renewing, an outage picking the turn back up (ChatPaneNotices). -->
                        <ChatPaneNotices />
                        <!-- THE TURN STOPPED BEFORE IT FINISHED, and here is the way on: one strip for every
                             ending that leaves work behind (ChatContinueStrip). Above the queue, because that
                             is the order the two answer "what is happening to my work": this one is what
                             becomes of the turn that stopped, and the queue is what goes next either way. -->
                        <ChatContinueStrip :visible="continueStrip" :ready="continueOffer" @continue="continueTurn" />
                        <template v-if="connected">
                            <!-- Messages written while the agent was busy that haven't reached it yet. They sit here
                             rather than in the transcript because they are not part of the conversation until the
                             agent has them: a steered one moves into the transcript the moment the daemon takes
                             it. Each is removable, so a queued thought can be withdrawn before it lands. -->
                            <div v-if="queued.length > 0" class="flex flex-col gap-1">
                                <div
                                    v-for="message in queued"
                                    :key="message.id"
                                    class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-overlay/60 px-3 py-2"
                                >
                                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs text-subtle" />
                                    <div class="min-w-0 flex-1">
                                        <p v-if="message.text" class="truncate text-2xs text-muted">{{ message.text }}</p>
                                        <p v-if="message.attachments.length > 0" class="truncate text-2xs text-subtle">
                                            <Icon name="file" class="text-2xs" />
                                            {{ message.attachments.map((file) => file.name).join(`, `) }}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        class="composer-ghost h-5 w-5 shrink-0"
                                        @click="removeQueued(message.id)"
                                        v-tooltip.top="'Remove: this message will not be sent'"
                                        aria-label="Remove queued message"
                                    >
                                        <Icon name="times" class="text-2xs" />
                                    </button>
                                </div>
                                <p class="px-1 text-2xs text-subtle">{{ queuedHint }}</p>
                            </div>
                            <!-- AN EDIT IN FLIGHT, said in the one place the user is certainly looking: directly
                                 over the box they are typing the replacement into. The struck rows up in the
                                 transcript are the count; this is the LABEL, which message, and the two ways
                                 out of it, and it has to be here rather than only up there because an edit
                                 aimed twenty turns back leaves nothing struck anywhere near the composer, and a
                                 box that has silently changed what Send does with no mark on it is the trap
                                 this whole mode is arranged to avoid.
                                 It sits LAST of the strips, closest to the box, because it is the only one of
                                 them that describes what the box itself is now for; the others describe what
                                 the conversation is doing.
                                 In the accent rather than the muted grey the strips above wear: those report a
                                 state the chat arrived at by itself, and this reports a mode the user armed and
                                 must be able to see they are still in. -->
                            <div
                                v-if="editing !== undefined"
                                class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-primary-500/40 bg-primary-600/10 px-3 py-2 text-2xs text-muted"
                            >
                                <Icon name="pencil" class="shrink-0 text-link" />
                                <span class="min-w-0 flex-1">
                                    Editing this message:
                                    <template v-if="editDropped > 1">it and the {{ editDropped - 1 }} below it are replaced when you send.</template>
                                    <template v-else>it is replaced when you send.</template>
                                </span>
                                <!-- The way out that keeps the answer. Deliberately BEFORE Cancel: a user
                                     hesitating over this strip is weighing "do I really want to lose that", and
                                     the offer that answers it should be the one their eye reaches first. -->
                                <Button
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    class="shrink-0"
                                    v-tooltip.top="'Open a new chat from here with what you have typed: this one keeps its answer'"
                                    @click="forkInsteadOfEdit"
                                >
                                    Keep both instead
                                </Button>
                                <Button
                                    size="small"
                                    :text="true"
                                    class="shrink-0"
                                    v-tooltip.top="'Leave everything as it is: nothing has been changed yet'"
                                    @click="cancelEdit"
                                >
                                    Cancel
                                </Button>
                            </div>
                            <!-- The whole box changes standing when the agent's voice is armed (.composer-voice):
                                 being in this mode by accident is the one mistake worth paint, because the words
                                 land in the transcript as the agent's own. -->
                            <form
                                class="ui-field-shell composer-frame relative flex flex-col rounded-2xl border-line-strong bg-overlay shadow-lg"
                                :class="{ 'composer-voice': voiceAgent }"
                                @submit.prevent="submit"
                            >
                                <ChatMentionPopover v-if="mentionOpen" ref="mentionPopover" :query="activeMention?.query ?? ''" @pick="pickMention" />
                                <ChatCommandPopover v-if="commandOpen" ref="commandPopover" :commands="commandMatches" @pick="pickCommand" />
                                <div v-if="attachments.length > 0 || editorChip" class="flex flex-wrap gap-2 px-3 pt-3">
                                    <!-- Editor-context chip: off by default, one click attaches the open file /
                                     selection to the next message: the inverse of VSCode Claude Code. Sized
                                     like the attachment chips beside it. Absent on a conversation that lives in
                                     another sandbox: the file it names is open in THIS workspace, at a path the
                                     daemon being written to has no reason to have (see `editorChip`). -->
                                    <button
                                        v-if="editorChip"
                                        type="button"
                                        class="ui-chip rounded-lg px-2 py-1.5 text-xs"
                                        :class="includeEditorContext ? `ui-chip-on` : `border-dashed border-line`"
                                        @click="includeEditorContext = !includeEditorContext"
                                        :aria-pressed="includeEditorContext"
                                        aria-label="Attach editor context"
                                    >
                                        <Icon name="code" class="shrink-0 text-2xs" />
                                        <span class="max-w-36 truncate">{{ editorChipLabel }}</span>
                                    </button>
                                    <div
                                        v-for="a in attachments"
                                        :key="a.id"
                                        class="relative flex items-center gap-2 overflow-hidden rounded-lg border py-1.5 pl-2 pr-1 text-xs"
                                        :class="a.status === 'failed' ? 'border-danger' : 'border-line bg-card'"
                                    >
                                        <!-- By path, like every other thumb in the app: staging a file files its
                                             object URL under its path (attachmentPreviews), so this chip and the
                                             bubble the message becomes are drawn from the same one answer. -->
                                        <ChatImageThumb
                                            v-if="attachmentPreview(a.path)"
                                            :src="attachmentPreview(a.path) ?? ''"
                                            :alt="a.name"
                                            size="h-9 w-9"
                                        />
                                        <Icon name="file" v-else class="text-sm text-subtle" />
                                        <span class="max-w-36 truncate text-content" v-tooltip.top="a.error ?? a.name">{{ a.name }}</span>
                                        <!-- The chip's own state, in a glyph. The progress hairline below is
                                             invisible once it fills, so a chip whose bytes are still in flight
                                             read as finished, while Send stayed disabled behind it. -->
                                        <Icon v-if="a.status === 'uploading'" name="spinner" spin class="shrink-0 text-2xs text-link" />
                                        <Icon
                                            v-else-if="a.status === 'failed'"
                                            name="exclamation-circle"
                                            class="shrink-0 text-2xs text-danger"
                                            v-tooltip.top="a.error ?? 'Upload failed'"
                                        />
                                        <button
                                            type="button"
                                            class="composer-ghost h-5 w-5 shrink-0"
                                            @click="staging.remove(a)"
                                            aria-label="Remove attachment"
                                        >
                                            <Icon name="times" class="text-2xs" />
                                        </button>
                                        <div
                                            v-if="a.status === 'uploading'"
                                            class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-500"
                                            :style="{ width: `${Math.round(a.progress * 100)}%` }"
                                        ></div>
                                    </div>
                                </div>
                                <!-- Body tier on desktop: what you type must read at the size it will land in the
                                 transcript. text-base below md: 16px is the iOS threshold under which focusing
                                 zooms the page. -->
                                <textarea
                                    ref="input"
                                    rows="1"
                                    v-model="draft"
                                    name="draft"
                                    :disabled="!canDrive"
                                    :placeholder="composerPlaceholder"
                                    class="field-bare scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto px-4 py-3 leading-relaxed md:text-xs"
                                    @input="onInput"
                                    @keydown="onKeydown"
                                    @keyup="syncCaret"
                                    @click="syncCaret"
                                    @paste="staging.onPaste"
                                ></textarea>

                                <!-- THE CONTROL ROW, IN TWO GROUPS THAT WRAP AS UNITS, and the wrapping is the
                                     point, not a nicety. Every pill in here is `shrink-0` (they are glyphs and
                                     short words; there is nothing in them to squeeze), so a single row of them
                                     had exactly one way to answer a column too narrow to hold it: run out past
                                     the edge. It did, at the width the docked column USED to ship at: the send
                                     button fell off the right side and the pane grew a sideways scrollbar under
                                     the whole transcript, on the first screen of a fresh sandbox.

                                     So the row is allowed to become two rows. The groups are the ones the pills
                                     already read as, which brain (model · effort), then how the turn is shaped
                                     and the press that sends it, and each stays whole, because a group broken
                                     mid-way is worse than a second line. `ml-auto` rather than
                                     `justify-between`: an auto margin holds the second group against the right
                                     edge whether it is sharing the first line or sitting on its own, where
                                     space-between would slam it left the moment it wrapped.

                                     WHAT THE ROW HOLDS IS NOW A FACT ABOUT THIS CHAT, not about the app. Four of
                                     the shaping controls (mode, persona, run-through, the agent voice) are here
                                     only while they are set to something other than this chat's default, and sit
                                     in the overflow beside the mic while they are not: composerMore.ts states
                                     the rule and says why. An ordinary chat therefore reaches Send in five
                                     controls where it used to take nine, and the wrap above is a thing that
                                     happens to an unusual chat on a narrow column rather than to every chat in
                                     the app on the first screen of a fresh sandbox. -->
                                <div class="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2.5 pb-2.5">
                                    <!-- MODEL, EFFORT, MODE, PERSONA GO INERT UNDER A WORKFLOW BADGE, and that is not
                                         a caveat about the feature: it is what the badge means. Every one of them
                                         describes a turn on THIS conversation, and a workflow send makes none: the
                                         message becomes a run's request, and each step opens its own unattended
                                         session on the provider, harness and model the step declares, looping the way
                                         the step says to loop. Left live they were four controls that changed nothing
                                         about the press beneath them: pick Opus · Max · Plan, watch the run come back
                                         on something else, and you would be right to call it a bug. The overflow dims
                                         with them, because a picked workflow has promoted run-through out into the
                                         row and everything still inside that menu is one of the four.

                                         The run-through badge is the exception, because it is the badge: see it for
                                         why it never dims.

                                         Dimmed rather than hidden: they still say what an ordinary send would use, the
                                         line under the box says whose they are instead, and the badge is one press
                                         from handing them back: a control that vanished would take that offer with
                                         it. -->
                                    <!-- WHICH BRAIN. `min-w-0` is what lets the model name give way first: it is
                                         the one thing in the row with a shrinkable middle, so a column a little
                                         too tight truncates a name rather than spending a whole second line.

                                         THE LABELS COME BACK AT THE WIDTH THEY FIT AT, WHICH IS NOT THE WIDTH
                                         THEY USED TO. Measured, at the sizes this row actually draws: the model
                                         name alone needs ~426px of pane to leave the row on one line, the
                                         effort word ~476. They were switching back on at 320 and 384: both of
                                         them 60-100px early, so widening the column from ~390 to ~540 turned
                                         labels on that immediately pushed the row onto two lines, and it took
                                         another 150px of dragging to earn the single line back. A reader who
                                         widens a column and watches it get TALLER is not looking at a responsive
                                         layout, they are looking at a bug. One breakpoint for the pair
                                         (`@max-lg`, 512px) clears the wider of the two requirements and puts
                                         them back together, which is also how they read: one row of words, not
                                         two.

                                         THE CHIPS TO THE RIGHT ARE NOT ON THIS BREAKPOINT and must not be put on
                                         it. Mode, persona and the rest are only in the row at all while they are
                                         set to something other than the default, so each of them keeps its word
                                         at every width: a chip that collapsed to a bare glyph on a narrow column
                                         would be back to the exact state the promotion rule exists to remove,
                                         and it would do it on the chats that can least afford it. What buys the
                                         room is that they are usually not there. -->
                                    <div class="flex min-w-0 items-center gap-1">
                                        <ComposerModelPill
                                            ref="modelPill"
                                            :conversation="conversation"
                                            :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                            :disabled="pickedWorkflow !== undefined"
                                            :expanded="modelOpen"
                                            :aria-label="`Provider and model: ${providerName} · ${modelLabelText}`"
                                            label-class="@max-xs:hidden"
                                            @click="modelOpen = !modelOpen"
                                        />

                                        <ComposerEffort
                                            :conversation="conversation"
                                            :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                            :disabled="pickedWorkflow !== undefined"
                                            label-class="@max-lg:hidden"
                                        />

                                        <!-- The tier judge's pre-send answer, and ONLY when the turn is really
                                             about to move: the draft looks simple, automatic tier selection is
                                             switched on, and there is a cheaper rung to move it to. Measure
                                             mode draws nothing here (tierPreview's header says why). Sits with
                                             the "which brain" group because it is a sentence about exactly
                                             that — it contradicts the pill next to it on purpose. It keeps its
                                             mark at every width and drops only its words (the chip owns that
                                             rule): a control announcing that your model is about to be
                                             substituted is the last thing a narrow pane should hide. -->
                                        <ComposerTierChip :conversation="conversation" />
                                    </div>

                                    <!-- HOW THE TURN IS SHAPED, AND THE PRESS THAT SENDS IT: the group that
                                         keeps the right edge (see the note on the row above).

                                         IT WRAPS INTERNALLY, which the row above says a group should not have to
                                         do, and the exception is earned. The group used to be a fixed set of
                                         pills that shed their words under `@max-lg` and so could always be made
                                         to fit; now its members are chips that keep their words at every width
                                         (see the labels note above), and four of them armed at once on a 330px
                                         column is wider than the column. Every chip is `shrink-0` and this is a
                                         flex line, so without `flex-wrap` that case does not squeeze or clip: it
                                         RUNS OUT PAST THE FRAME, chips and Send both, which is the exact bug the
                                         outer row's wrapping exists to prevent and which returned here the day
                                         the labels stopped hiding.

                                         `justify-end` so the overflow lines stay against the right edge with
                                         Send, rather than stacking left and leaving the press adrift. A tall
                                         composer on a narrow column with four things armed is a fair price: it
                                         is rare, it is entirely made of state the user chose, and the wrap is
                                         the only answer that neither clips a control nor takes its word away. -->
                                    <div class="ml-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1.5">
                                        <!-- MODE, and the group's order is a gradient away from the model, kept
                                         whether or not any given chip is showing: which brain (model · effort),
                                         then how it works (mode), where it runs (placement), who it is
                                         (persona), what the message is run through (loop or workflow), whose
                                         words are in the box (voice), and the overflow holding whichever of them
                                         is at its default. A chip appearing must slot into the order the row
                                         already had, never append itself to the end, or the row's arrangement
                                         would be a history of what the user switched on and in what sequence.

                                         Mode sits closest to effort because the two are one thought: how hard it
                                         thinks, and how much rope it has. It is worded whenever it is here (see
                                         the note on labels above): it is here because the posture is not this
                                         chat's usual one, and that is not a thing to say in a glyph. -->
                                        <button
                                            v-if="inRow.mode"
                                            ref="modePill"
                                            type="button"
                                            class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                            :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                            :disabled="pickedWorkflow !== undefined"
                                            @click="modeOpen = !modeOpen"
                                            :aria-expanded="modeOpen"
                                            aria-label="Agent mode"
                                        >
                                            <Icon :name="modeIcon" class="text-2xs text-link" />
                                            <span>{{ modeLabel }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </button>

                                        <!-- WHERE IT RUNS, the one control in the group that is about the machine
                                         rather than the message: this sandbox, a runner of its own on another
                                         computer, or another sandbox on this account. Hidden entirely until there
                                         is somewhere else to choose, and read-only once the conversation has run,
                                         because placement is part of a conversation's identity
                                         (ChatPlacementMenu).

                                         NOT ON THE PROMOTION RULE, and deliberately: "Here" is a default like
                                         any other and would collapse under it, but where an agent is running is
                                         the fact people switch most and check before nearly every send, so it
                                         holds its slot whatever it says. The rule buys room for the controls
                                         worth keeping; spending that room on this one is the point of it.

                                         The glyph follows the KIND of place: a stack of boxes once the chat
                                         lives in another sandbox, the single machine otherwise, so the pill says
                                         which of the three answers is in force before its label is read. -->
                                        <button
                                            v-if="placementShown"
                                            ref="placementPill"
                                            type="button"
                                            class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                            @click="placementOpen = !placementOpen"
                                            :aria-expanded="placementOpen"
                                            aria-label="Where this runs"
                                        >
                                            <Icon :name="remote ? `boxes` : `desktop`" class="text-2xs text-link" />
                                            <span class="@max-lg:hidden">{{ placementLabel }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </button>

                                        <!-- PERSONA, who the chat IS when it reaches outside: which of your accounts
                                         this turn may speak through, and how much of the toolbox it holds.

                                         ONLY EVER HERE WHEN IT IS SOMEBODY, which is the whole promotion rule
                                         (composerMore.ts) landing on the control that most needed it. Unset, it
                                         was a bare grey glyph the composer carried on every chat in the app to
                                         announce that this one was nobody in particular: the most-shown, least-
                                         read thing in the row. Set, it must be impossible to miss, because a
                                         message about to go out under somebody's account has to say whose before
                                         it is sent, not after. So it is absent from most chats and NAMED in the
                                         active tint on the few, and "Acts as · Anyone" sits in the overflow for
                                         anyone looking to change that. Nothing about the armed state is softer
                                         than it was; what went is the advertisement of the unarmed one.

                                         ABSENT ON A CHAT THAT LIVES IN ANOTHER SANDBOX, whatever it is set to. A
                                         persona is a card in one daemon's record, so the id this pill would set
                                         names nothing over there and the send drops it (turnRequest.ts): the turn
                                         is an ordinary attended chat on that box's own accounts, and a pill that
                                         pretended otherwise would be promising an identity to a machine that has
                                         never heard of it. -->
                                        <button
                                            v-if="inRow.persona"
                                            ref="personaPill"
                                            type="button"
                                            class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                            :class="{
                                                'composer-active': pickedWorkflow === undefined,
                                                'composer-steered': pickedWorkflow !== undefined,
                                            }"
                                            :disabled="pickedWorkflow !== undefined"
                                            @click="personaOpen = !personaOpen"
                                            v-tooltip.top="`This chat acts as ${personaName}: only its accounts are in reach`"
                                            :aria-expanded="personaOpen"
                                            :aria-label="`Acts as: ${personaName}`"
                                        >
                                            <!-- IT WEARS THE FACE, and falls back to the glyph only for a card that
                                                 has gone missing: the character every other surface identifies
                                                 this persona by belongs on the last control seen before Enter.
                                                 The name rides beside it at EVERY width, unlike the pills either
                                                 side of it: a chip is in this row because it is doing something
                                                 to the next send, and one that collapsed to a bare glyph on a
                                                 narrow column would be back to the state this rule removed. -->
                                            <PersonaFace v-if="pickedPersona !== undefined" :persona="pickedPersona" :size="16" />
                                            <Icon v-else name="users" class="text-2xs text-link" />
                                            <span class="max-w-32 truncate">{{ personaName }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </button>

                                        <!-- RUN THROUGH: ONE control where there were two. A loop and a workflow
                                         answer the same question about the next message (what is it run THROUGH)
                                         with answers the composer can only take one of, so they are one badge:
                                         picking is picking, and a pick replaces a pick. Two glyphs side by side
                                         said the same thing only by greying each other out, which is a rule you
                                         learn by tripping over it.

                                         Armed, it wears the CHOSEN thing's own icon and names it in the active
                                         tint: a composer about to spend money round after round, or to fan one
                                         message across paid sessions, says so before the press rather than
                                         after it. Unarmed there is nothing to say, so it says nothing and sits
                                         in the overflow as a named row instead — which is where the merge above
                                         was always heading. That merge halved a pair of mute glyphs; the
                                         promotion rule (composerMore.ts) finished the job by noticing that the
                                         remaining one was mute on almost every chat in the app.

                                         A RUNNING loop takes it over entirely: the count replaces the name,
                                         the press ends it, and that outranks even an armed workflow, because
                                         stopping something already going is not a thing the next message
                                         decides. It is also why "running" counts as armed for the rule: a badge
                                         that let a live loop fall into a menu would leave it no way out but the
                                         fleet board. -->
                                        <button
                                            v-if="inRow.runThrough"
                                            ref="runThroughPill"
                                            type="button"
                                            class="composer-active composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                            :disabled="runningLoop !== undefined && !reachable"
                                            @click="runningLoop ? endLoop() : (runThroughOpen = !runThroughOpen)"
                                            v-tooltip.top="runThroughHint"
                                            :aria-pressed="runningLoop !== undefined"
                                            :aria-expanded="runningLoop ? undefined : runThroughOpen"
                                            :aria-label="runThroughLabel"
                                        >
                                            <Icon :name="runThroughIcon" class="text-2xs text-link" :spin="runningLoop !== undefined" />
                                            <span v-if="runningLoop">{{ runningLoop.iteration }}/{{ runningLoop.maxIterations }}</span>
                                            <template v-else-if="runThroughName !== undefined">
                                                <span class="max-w-32 truncate">{{ runThroughName }}</span>
                                                <Icon name="chevron-down" class="text-2xs text-subtle" />
                                            </template>
                                        </button>

                                        <!-- VOICE: the box is writing the AGENT's words, not yours. The next Send
                                         PLACES the draft into the transcript as the agent's own: no turn, no
                                         reply: then disarms. Last of the shaping chips and nearest to Send,
                                         because it changes what Send IS more than anything else in the row:
                                         every other control shapes a turn, this one removes the turn entirely.

                                         ARMED-ONLY, and the clearest case for the whole rule (composerMore.ts).
                                         This is a rare, deliberate, one-shot act: the composer used to advertise
                                         it with a permanent glyph on every chat that had ever run a turn, which
                                         is a lot of pixels spent on a control almost nobody is about to press,
                                         and it read as decoration in a row of other glyphs. Off, it is a named
                                         row in the overflow, where its sentence can actually say what it does.
                                         On, the whole composer already changes standing (.composer-voice), and
                                         this chip is the piece of that a reader can press to take it back.

                                         Offered from the conversation's first turn (a draft chat has no
                                         transcript to place into), and a workflow badge greys it like the rest:
                                         a run's request is nobody's transcript. -->
                                        <button
                                            v-if="inRow.voice"
                                            type="button"
                                            class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                            :class="{
                                                'composer-active': pickedWorkflow === undefined,
                                                'composer-steered': pickedWorkflow !== undefined,
                                            }"
                                            :disabled="pickedWorkflow !== undefined || editing !== undefined"
                                            @click="voiceAgent = false"
                                            v-tooltip.top="
                                                editing !== undefined
                                                    ? `Finish or cancel the edit first: this box is holding a message to replace`
                                                    : `Writing as the agent: Send places the words into the transcript, no reply. Press to write as yourself again`
                                            "
                                            :aria-pressed="true"
                                            aria-label="Writing as the agent"
                                        >
                                            <Icon name="robot" class="text-2xs text-link" />
                                            <span>As agent</span>
                                        </button>

                                        <!-- THE OVERFLOW, and the reason the four pills above are conditional at all
                                             (composerMore.ts states the rule; this is where it is spent). It holds
                                             every one of them that is sitting at this chat's default, each as a row
                                             carrying its NAME, its current value and a sentence: which is strictly
                                             more readable than the bare glyph it replaces, whose only explanation
                                             was a tooltip no touch device has ever shown anyone. Nothing is hidden
                                             that is doing anything; a control set to something else has left this
                                             menu and is a named chip to the left.

                                             It is the row's growth story too. Before this, every feature that
                                             wanted a place in the composer took a permanent slot beside Send, so
                                             the row's width tracked the roadmap rather than the chat. The next one
                                             lands in here and only earns the row by being switched on.

                                             LAST OF THE SHAPING CONTROLS, immediately before the mic, so it holds
                                             one fixed spot while the chips to its left come and go: an overflow
                                             that moved as the chat changed would be worse than the glyphs it
                                             replaced. It goes with them under a workflow badge: everything left
                                             inside it is a control that badge has taken over. -->
                                        <button
                                            v-if="moreRows.length > 0"
                                            ref="morePill"
                                            type="button"
                                            class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                            :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                            :disabled="pickedWorkflow !== undefined"
                                            @click="moreOpen = !moreOpen"
                                            v-tooltip.top="moreHint"
                                            :aria-expanded="moreOpen"
                                            aria-label="More composer settings"
                                        >
                                            <Icon name="sliders-h" class="text-xs max-md:text-base" />
                                        </button>

                                        <!-- HANDS-FREE VOICE: one tap arms it, and from there the pause is the send
                                     (see useComposerVoice). Every browser gets this button now: the
                                     transcription is the sandbox's own, so there is no per-browser support
                                     to gate on: only the viewer role, which cannot send at all. While
                                     listening the icon breathes with the microphone level, which is the whole
                                     "it can hear you" indicator; a state label rides the hint slot below. -->
                                        <button
                                            v-if="canDrive"
                                            type="button"
                                            class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                            :class="{ 'composer-active': voiceOn }"
                                            :disabled="!reachable && !voiceOn"
                                            @click="toggleVoice"
                                            v-tooltip.top="voiceHint"
                                            :aria-pressed="voiceOn"
                                            aria-label="Talk hands-free"
                                        >
                                            <Icon
                                                name="microphone"
                                                class="text-xs transition-transform max-md:text-base"
                                                :style="
                                                    voiceState === 'listening'
                                                        ? { transform: `scale(${1 + Math.min(0.5, voiceLevel * 3)})` }
                                                        : undefined
                                                "
                                            />
                                        </button>

                                        <!-- Stop is present for the whole live turn: generating OR parked on a plan /
                                     question / permission card. A parked turn still holds the conversation's run
                                     lock, so without this the user's only exits were answering a card they didn't
                                     want to answer or closing the tab.

                                     It sits BEFORE Send in the row and never moves out of that order, so the two
                                     never trade places under a finger: with an empty box (no Send, see
                                     `sendShown`) it simply inherits the end of the row. -->
                                        <button
                                            v-if="streaming"
                                            type="button"
                                            class="composer-send composer-stop shrink-0 max-md:h-11 max-md:w-11"
                                            :disabled="!reachable"
                                            @click="stop"
                                            v-tooltip.top="stopHint"
                                            :aria-label="stopLabel"
                                        >
                                            <Icon name="stop" class="text-sm" />
                                        </button>
                                        <!-- Send stands alongside Stop for as long as there is a message to send: mid-turn
                                     text goes into the running turn where the harness takes it, and queues behind
                                     the turn where it doesn't. There is no message the composer has nowhere to put,
                                     so anything typed keeps this button on screen — and an empty box mid-turn hands
                                     the slot to Stop rather than parking a dead circle in it (`sendShown`). -->
                                        <button
                                            v-if="sendShown"
                                            type="submit"
                                            class="composer-send shrink-0 max-md:h-11 max-md:w-11"
                                            :disabled="!canSend || !reachable"
                                            v-tooltip.top="sendHint"
                                            aria-label="Send"
                                        >
                                            <Icon name="send" class="text-sm" />
                                        </button>
                                    </div>
                                </div>
                            </form>

                            <p v-if="voiceErrorMessage" class="px-1 text-2xs text-danger">{{ voiceErrorMessage }}</p>
                            <p v-if="workflowFailure" class="px-1 text-2xs text-danger">{{ workflowFailure }}</p>
                            <p v-else-if="loopFailure" class="px-1 text-2xs text-danger">{{ loopFailure }}</p>
                            <!-- What the badge changes about the press, said under the box that is about to do
                                 it: the message is going to a design, not to this chat. The second sentence is
                                 what the greyed pills above would otherwise only say on hover, and a control
                                 that refuses has to name itself somewhere a touch device can read it. -->
                            <p v-else-if="pickedWorkflow" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="sitemap" class="shrink-0 text-2xs text-link" />Send starts "{{ pickedWorkflow.name }}": this message is
                                what every step is asked to do. Model, effort, mode and looping are each step's own.
                            </p>
                            <!-- The loop badge's own sentence, and it carries the STOP CONDITION rather than just
                                 the name. This is the one badge in the row whose press starts something that goes
                                 on spending after the user has looked away, so "what ends it" belongs where the
                                 message is being written, not behind a hover on the pill, which no touch device
                                 will ever show anyone. -->
                            <p v-else-if="runThroughState === 'loop' && pickedLoop" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="repeat" class="shrink-0 text-2xs text-link" />Send loops this message until it's met: ends on
                                {{ loopDesignLine(pickedLoop) }}.
                            </p>
                            <!-- A persona that CANNOT do what the pill implies, said where the message is being
                                 written rather than discovered when the turn comes back empty-handed. Only ever
                                 the states the pill itself can't show: a card that has gone missing, one with no
                                 accounts on it, one whose accounts are all still signed out. A working persona
                                 says everything it needs to by being named above. -->
                            <p v-else-if="personaNotice" class="flex items-center gap-1.5 px-1 text-2xs text-warning">
                                <Icon name="exclamation-circle" class="shrink-0 text-2xs" />{{ personaNotice }}
                            </p>
                        </template>
                    </template>
                </div>
            </div>
        </div>

        <!-- The pane's status bar, and the one part of the footer that stayed OUT of the scroller: it is
             about the pane (how full the context is, how much of the subscription is left, whether the
             daemon is up), not about the message being written, and unlike the composer it has no surface
             of its own to keep it legible over a transcript sliding beneath it. Below the scroller it sits
             on the panel's own background, which is where a status bar belongs and where Claude's own
             "check important info" line sits.

             The block slot carries the REFUSAL and nothing else. It used to be overridden with "The sandbox is
             busy" whenever `reachable` went false, which is a transport fact and a bad thing to render: the
             liveness stream reconnects for ordinary reasons every minute or two, the first retry is one second
             long, and the line therefore blinked on and off under the composer of a workspace nothing was wrong
             with. That sentence has one home, the notification lane (notificationSources.ts), which raises it
             only once the wait has lasted long enough to be worth a reader's attention; what the composer owes
             its reader is why SEND is dark, and that is on the button (sendHint). -->
        <ChatPaneStatus v-if="connected" :block="refusal" :hint="composerHint" />

        <!-- The four composer menus, each in the app's standard touch swap (ResponsiveOverlay): an anchored
             panel on desktop, a bottom sheet on a phone, one open flag either way. No height cap on any of them
            : the overlay measures the room its side of the pill actually has IN THE PILL'S OWN WINDOW and caps
             itself to it, so a picker fits whether this panel is docked in a column or floating in a window the
             user has since made short, and the `min-h-0` column passes that cap down to the scrolling list
             inside (see ChatModelPicker). -->
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" header="Model" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="modeOpen" :anchor="modeAnchor" cross="end" header="Agent mode" panel-class="w-56 p-1">
            <ChatModeMenu @selected="modeOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="personaOpen" :anchor="personaAnchor" cross="end" header="Acts as" panel-class="w-80 p-1">
            <ChatPersonaMenu :picked="conversation.actsAs.value" @picked="pickPersona($event)" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="placementOpen" :anchor="placementPill" cross="end" header="Where this runs" panel-class="w-80 p-1">
            <ChatPlacementMenu :conversation="conversation" @selected="placementOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="runThroughOpen" :anchor="runThroughAnchor" cross="end" header="Run this message through" panel-class="w-80 p-1">
            <ChatRunThroughMenu
                :loop="conversation.loopId.value"
                :workflow="conversation.workflowId.value"
                @loop="pickLoop($event)"
                @workflow="pickWorkflow($event)"
                @manage="manageRunThrough()"
            />
        </ResponsiveOverlay>
        <!-- The overflow itself. Its rows hand off to the three panels above, which then open over THIS button
             (modeAnchor and the two beside it), so a control reached through the menu still makes its choice in
             the one list that owns it. -->
        <ResponsiveOverlay v-model="moreOpen" :anchor="morePill" cross="end" header="This message" panel-class="w-80 p-1">
            <ComposerMoreMenu :rows="moreRows" @pick="openFromMore($event)" />
        </ResponsiveOverlay>
    </div>
</template>
