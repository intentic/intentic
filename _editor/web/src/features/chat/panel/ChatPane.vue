<script setup lang="ts">
import { Button, Icon, Notice, PersonaFace, ResponsiveOverlay, growTextarea, useDevice, useLoadingReveal } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { type AgentCommand, isTrialProvider, loopDesignLine, personaModels } from "@intentic/sandbox-contract";
import { turnInFlight } from "../../agents/fleet/agentStatus";
import { boxNameOf, scopeOffered } from "../../agents/fleet/fleetScope";
import { useAgents } from "../../agents/fleet/useAgents";
import { modeMeta } from "../models/catalog";
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
} from "../composer/composerIntent";
import type { Conversation } from "../session/conversation";
import { modelLabelFor, providerDisplayLabel } from "../accounts/providerCatalog";
import { pickUpReady } from "../run/pickUp";
import { type ChatMessage, cutsAboveOf, dayMarksOf, forkCutsOf, liveBubbleOf, repeatedChecklistIds, turnsOf } from "../transcript/transcript";
import { withShortcut } from "../../../shell/commands/useCommands";
import { navigateInApp } from "../../../shell/window/mainWindow";
import { invalidateAgentTranscript } from "../transcript/agentTranscript";
import { useChat } from "../run/useChat";
import { ensureProviderCommands } from "../models/useChat-catalog";
import { hydrateOnce } from "../run/useChat-sessions";
import { conversationView, PANE_VIEW } from "./useChat-view";
import { CHAT_SURFACE } from "../tools/chatToolSurface";
import { workspaceSurface } from "./workspaceSurface";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import { usePersonaRoute } from "../personas/personaRoute";
import { roleSources } from "../accounts/roleModel";
import { useRole } from "../../sandbox/secrets/useRole";
import { attachmentPreview } from "../drafts/attachmentPreviews";
import { useChatAttachments } from "../drafts/useChatAttachments";
import { useComposerVoice } from "../composer/useComposerVoice";
import { useEditorContextChip } from "../composer/useEditorContextChip";
import { useRunThrough } from "../models/useRunThrough";
import { useStickToBottom } from "../transcript/useStickToBottom";
import { useTranscriptWarmup } from "../transcript/useTranscriptWarmup";
import { isBlocked } from "../../sandbox/live/connection";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { inputHistoryFor, recallStep } from "../drafts/inputHistory";
import { insertMention, mentionQueryAt } from "../composer/useMentions";
import ChatCommandPopover from "../composer/ChatCommandPopover.vue";
import ChatContinueStrip from "./ChatContinueStrip.vue";
import ChatImageThumb from "../transcript/ChatImageThumb.vue";
import ChatMentionPopover from "../composer/ChatMentionPopover.vue";
import ChatForkCut from "../transcript/ChatForkCut.vue";
import ChatForkLine from "../transcript/ChatForkLine.vue";
import ChatMessageView from "../transcript/ChatMessageView.vue";
import ChatModelPicker from "../models/ChatModelPicker.vue";
import { useRunners } from "../../sandbox/devices/useRunners";
import ChatModeMenu from "../models/ChatModeMenu.vue";
import ChatPlacementMenu from "./ChatPlacementMenu.vue";
import ChatPaneNotices from "./ChatPaneNotices.vue";
import ChatPaneStatus from "./ChatPaneStatus.vue";
import ChatPersonaMenu from "../personas/ChatPersonaMenu.vue";
import ChatRunThroughMenu from "../models/ChatRunThroughMenu.vue";
import ChatTranscriptSkeleton from "../transcript/ChatTranscriptSkeleton.vue";
import ChatTurnStatus from "../transcript/ChatTurnStatus.vue";
import ComposerEffort from "../composer/ComposerEffort.vue";
import ComposerModelPill from "../composer/ComposerModelPill.vue";
import ComposerMoreMenu from "../composer/ComposerMoreMenu.vue";
import ComposerTierChip from "../composer/ComposerTierChip.vue";
import { type ComposerControl, overflowRows, ridesRow } from "../composer/composerMore";
import { startingMode } from "../run/turnDefaults";

// One chat on screen: the transcript, its composer, and the pickers/banners for one conversation (ChatPanel owns
// the surrounding frame — list, pop-out, resize, shell commands). Takes its conversation as a prop rather than
// reading the focused one, and provides `conversationView` once so everything under it answers for the same chat.
// Wiring only: what a press means lives in composerIntent.ts; the mic, attachments, run-through and scroll
// warm-up are composables; banners and status are their own components.

const props = defineProps<{
    conversation: Conversation;
    // The pane the keyboard acts on; only the focused pane answers the shell's caret-focus signal.
    focused: boolean;
    // Whether this pane's column can be closed back into a single view; decided by the panel, not this chat.
    closable: boolean;
}>();

// The typewriter is this pane's; only the focused pane runs one (TranscriptClock.watched). Written as an effect,
// not at mount, since a pane's conversation and focus both move: the chat it leaves must stop animating there.
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

// Working in a pane focuses it (a click, or the caret arriving via Tab or a closed picker); only raised when this
// pane doesn't already hold focus, so a click in the focused pane never re-seats it.
const emit = defineEmits<{ focus: []; close: [] }>();
const takeFocus = (): void => {
    if (!props.focused) {
        emit(`focus`);
    }
};

// Ends the column, not the conversation — the chat stays in the rail. Only the focused pane's button teaches the
// `chat.closePane` shortcut, since it acts on the focused pane.
const CLOSE_PANE = `Close this pane: the chat stays open`;
const closeHint = computed(() => (props.focused ? withShortcut(CLOSE_PANE, `chat.closePane`) : CLOSE_PANE));

// The prop as a ref, for the view and composables that follow this pane from one chat to the next.
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
// The shell-wide signals the composer answers; the only things read off the store, not this conversation.
const { composerFocus } = useChat();
const router = useRouter();
// What this pane's tool cards can lead to; per-pane like the view above, so two chats side by side each offer
// their own shell/browser, not the focused chat's.
provide(
    CHAT_SURFACE,
    workspaceSurface({
        agent: () => (props.conversation.isolated.value ? props.conversation.conversationId : undefined),
        terminal: () => props.conversation.agentTerminal.value,
        browser: () => props.conversation.agentBrowser.value,
        // Every destination is an app view; a popped-out chat has no app in it, so navigation there goes to the app's
        // own
        // window (mainWindow.ts) instead of replacing this chat.
        navigate: (route) => navigateInApp(router, route),
    }),
);
const { activeSandboxId, reachable, connection } = useSandbox();
// The daemon refused this account outright, unlike "not connected yet": waiting won't fix it.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
const blocked = computed(() => connection.value.failure !== undefined && isBlocked(connection.value.failure));
const { mobile } = useDevice();

// Pill labels render as our own text, always a real model name (catalogs: contract's agent-catalog.ts,
// chat/catalog.ts). Uses `providerDisplayLabel`, not the static table, which falls through to a raw id for
// capability-derived providers.
const providerName = computed(() => providerDisplayLabel(provider.value));
// Shared with the picker menu so they can't drift; falls back to the provider name while a catalog loads.
const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));
// The trial has no vendor to name — it's the product's own channel, not somebody's account.
const onTrial = computed(() => isTrialProvider(provider.value));
// Neither pill carries a hover label: the model pill's said the provider name its logo already shows, the mode
// pill's repeated the menu's own description. A turn running a different model than selected has lost that home;
// it belongs on the turn, not a hover about the next one.
const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
// The sticky footer, textarea included: its chrome's height is what's left for the box to grow into.
const footer = ref<HTMLElement>();
// One open flag per picker menu (desktop panel or mobile sheet, via ResponsiveOverlay), not one per surface — they
// drifted apart once already. The pill anchors the panel, so a popped-out window's overlay still lands correctly.
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
// The overflow's button; also the anchor three pickers fall back to when their own chip isn't in the row.
const morePill = ref<HTMLElement>();

// Auto-follow: stays at the newest content unless the user scrolled up. The composable owns the rule; the pane
// only says when a new transcript is on screen or a send just happened.
const { pin, follow } = useStickToBottom(scroller, content);

const activeError = computed(() => props.conversation.error.value);
// This conversation's transcript load, still in flight with nothing painted (empty state defers to loading).
// Gated by useLoadingReveal so a warm daemon's fast answer doesn't flash a placeholder; keyed on the conversation
// so a tab switch drops it at once.
const activeLoading = useLoadingReveal(
    computed(() => props.conversation.loading.value),
    computed(() => props.conversation.conversationId),
);

const { agentById } = useAgents();

// Follows the fleet for conversations the daemon hasn't created yet: their one-shot reads never retry, so the
// roster's live stream tells a non-streaming pane when the conversation exists or its turn begins/settles, and it
// hydrates. Primitive-valued so only an actual transition fires the watch; `undefined` (off the roster) changes
// nothing.
const fleetTurn = computed<boolean | undefined>(() => {
    const agent = agentById(props.conversation.conversationId);
    return agent === undefined ? undefined : turnInFlight(agent);
});
// Whether this tab streamed the turn the roster is about to settle: its transcript already has the result.
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
    // Being on the roster is the registration fact: heals a tab whose early probe read 'unknown agent' as final.
    props.conversation.registered.value = true;
    hydrateOnce(props.conversation);
});

// The bubble this turn writes into, if any (liveBubbleOf); recomputed per frame, scanning only the tail.
const liveBubble = computed(() => liveBubbleOf(messages.value));

// True for the assistant bubble currently being streamed into.
const isStreaming = (message: ChatMessage): boolean => streaming.value && liveBubble.value?.id === message.id;

// The same state with no bubble yet: a sent turn before its first frame (worktree cut, harness spawn, first
// token — can last minutes on a retrying provider). Drawn at the foot of the column so the spinner doesn't jump
// when the bubble opens; excludes `awaitingDecision` since a parked card is the prompt, not idle work.
const showTurnStatus = computed(() => streaming.value && !awaitingDecision.value && liveBubble.value === undefined);

// The transcript as prompt-headed groups, each the box its prompt stays pinned within; recomputed shallowly.
const turns = computed(() => turnsOf(messages.value));
const repeatedChecklists = computed(() => repeatedChecklistIds(messages.value));

// The transcript's date: named above the first turn sent on a given day, and nowhere else (dayMarksOf). One
// marker per day change lets each prompt's own stamp shrink to just the clock (ChatMessageView's sentClock).
const dayMarks = computed(() => dayMarksOf(turns.value));

// What a fork below each turn inherits: the flat index the grouped render otherwise throws away (forkCutsOf).
// Built as one index rather than searched per turn, since `turns` rebuilds every streaming paint.
const forkCuts = computed(() => forkCutsOf(turns.value));

// The boundaries that index doesn't cover, keyed by the message each sits above (cutsAboveOf): a turn's folded
// messages, and the conversation's first. Built here for the same reason as `forkCuts`.
const cutsAbove = computed(() => cutsAboveOf(turns.value));

// The ids an edit in progress would drop, from the edited message down, so the transcript can strike them while
// they're still present. A set, not an index, since it's read per row by id, and ids survive `turns` rebuilding
// under a streaming turn.
const doomed = computed<ReadonlySet<number>>(() => {
    const target = editing.value;
    if (target === undefined) {
        return new Set();
    }
    const from = messages.value.indexOf(target);
    return from < 0 ? new Set() : new Set(messages.value.slice(from).map((message) => message.id));
});

// How many bubbles an armed edit takes; derived from `doomed` so it can't disagree with the strike-through.
const editDropped = computed(() => doomed.value.size);

// Keep both instead: forks from inside the edit at the cut it was aimed at, so the new tab inherits everything
// above and opens with the original prompt, while this pane keeps the half-written replacement. Forks "now", not
// "then", since this is an escape hatch and must not itself be destructive.
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
    // Ends the edit first, so this pane's composer returns to what the pencil displaced before the fork.
    cancelEdit();
    const fork = forkAt(cut, `now`);
    // The fork opens with the original prompt (forkAt), overwritten with the user's half-written replacement.
    if (fork !== undefined) {
        fork.draft.value = carried;
        fork.attachments.value = [...staged];
    }
};

// Composer controls.
const modeLabel = computed(() => modeMeta(mode.value).label);
const modeIcon = computed(() => modeMeta(mode.value).icon);

// Grows to content up to a measured cap (growTextarea owns how); callers must re-measure via `nextTick`/a
// post-flush watch, since the DOM updates before layout. The cap is the scroller's free height minus the
// composer's chrome and a peek strip, floored at 192px, re-measured on every pane resize.
const COMPOSER_FLOOR = 192;
const TRANSCRIPT_PEEK = 72;
const composerCap = ref(COMPOSER_FLOOR);
const measureCap = (): void => {
    const box = scroller.value;
    const shell = footer.value;
    const field = input.value;
    // Nothing laid out yet measures nothing; the last good cap stands until there's a real measurement.
    if (box === undefined || shell === undefined || field === undefined || shell.offsetHeight <= 0) {
        return;
    }
    const chrome = shell.offsetHeight - field.offsetHeight;
    composerCap.value = Math.max(COMPOSER_FLOOR, box.clientHeight - chrome - TRANSCRIPT_PEEK);
};
const grow = (): void => {
    measureCap();
    growTextarea(input.value, composerCap.value);
};

// Re-measures when the pane's free space changes (a resize, a split, a sibling pane). Only the scroller is
// observed — watching the footer too would loop, since growing the box changes the footer's height.
const paneSize = typeof ResizeObserver === `undefined` ? undefined : new ResizeObserver(() => grow());
watch(
    scroller,
    (now, before) => {
        if (before !== undefined) {
            paneSize?.unobserve(before);
        }
        if (now !== undefined) {
            paneSize?.observe(now);
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => paneSize?.disconnect());

// Where this conversation lives: `box` is undefined for most chats (this browser's own sandbox); when set, the
// turn runs on that daemon and this pane is one of its renderers. The pane refuses each control that only makes
// sense on this machine, at its own control, rather than one banner over a half-working composer.
const conversationBox = computed(() => chat.value.box.value);
const remote = computed(() => conversationBox.value !== undefined);
// The box's name, read from the roster, not copied onto the conversation, so a rename can't go stale here.
const remoteName = computed(() =>
    conversationBox.value === undefined ? undefined : (boxNameOf.value.get(conversationBox.value) ?? `another sandbox`),
);

// Files staged for the next turn (useChatAttachments); bytes go to the conversation's own box and path.
const staging = useChatAttachments({ attachments, reachable, connected, at: conversationBox });
const { dragDepth } = staging;

// The chip offering the file the user is looking at (useEditorContextChip).
const { target: editorTarget, include: includeEditorContext, label: editorChipLabel, forSend: editorContextForSend } = useEditorContextChip();
// Offered only for a conversation running where that file lives; the send drops it for a remote one anyway.
const editorChip = computed(() => editorTarget.value !== undefined && !remote.value);

// Send is usable whenever there's something to send (text, a finished attachment, a queued message), regardless
// of what the conversation is doing — mid-turn text is delivered or queued, and a pending plan takes typed text as
// revision feedback.
const staged = computed(() => draft.value.trim().length > 0 || attachments.value.length > 0);
// The composer's voice, yours or the agent's: armed, the next Send places the words into the transcript as an
// assistant bubble (no turn), and disarms itself. Per-pane; offered only once a turn has run, since the route
// needs a registry entry to place into.
const voiceAgent = ref(false);

// Where the next agent runs: this sandbox, one of its runners, or another sandbox (ChatPlacementMenu). Shown only
// when there's somewhere else to choose, or the chat is already placed; uses `scopeOffered`, the same test the
// board's scope control uses.
const { runners: pairedRunners } = useRunners();
const placementLabel = computed(() => remoteName.value ?? props.conversation.runner.value ?? `Here`);
const placementShown = computed(
    () => pairedRunners.value.length > 0 || scopeOffered.value || props.conversation.runner.value !== undefined || remote.value,
);
const placeable = computed(() => props.conversation.registered.value || agentById(props.conversation.conversationId) !== undefined);

// The badge for what the next message runs through: a loop, a workflow, or nothing (useRunThrough).
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

// What the row shows vs. the overflow holds (composerMore.ts owns the rule; this is its reading). Mode, persona,
// run-through and voice ride the row while set to anything but this chat's default, and sit in the overflow
// otherwise; model, effort and placement always stay in the row.
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
// What's behind the overflow button, said on the button — the one thing it owes a reader before they press it.
const moreHint = computed(() => moreRows.value.map((row) => row.label).join(` · `));

// Each picker opens over whichever element it was reached from: its own chip when set, the overflow button
// otherwise. One flag either way, so nothing can end up anchored to an element no longer on screen.
const modeAnchor = computed(() => (inRow.value.mode ? modePill.value : morePill.value));
const personaAnchor = computed(() => (inRow.value.persona ? personaPill.value : morePill.value));
const runThroughAnchor = computed(() => (inRow.value.runThrough ? runThroughPill.value : morePill.value));

// A row in the overflow hands off to the control that owns the choice. Closes this panel first so the next one's
// dismissal (armed after this handler runs) never catches the same pointerdown; voice has nothing to pick, so its
// row is the press itself.
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

// Nothing else that rewrites what Send means survives an armed edit: the voice and both run-through picks clear,
// since only one answer to "what does send do" can hold, and the edit wins as the most specific act. Cleared
// visibly rather than only disabled, so the precedence is seen, not discovered by pressing Send.
watch(editing, (armed) => {
    if (armed === undefined) {
        return;
    }
    voiceAgent.value = false;
    runThrough.clear();
});
// A workflow badge takes the composer over entirely; an armed voice under it misattributes the next send.
watch(pickedWorkflow, (picked) => {
    if (picked !== undefined) {
        voiceAgent.value = false;
    }
});
// Closes the model/mode/persona panels whenever their pill stops being usable: disconnecting unmounts the pill
// under an open panel, and a picked workflow greys it without closing what's already open. Run-through is
// deliberately excluded — it's the one control a picked workflow leaves live, since it holds the pick.
watch([connected, pickedWorkflow], ([isConnected, workflow]) => {
    if (!isConnected || workflow !== undefined) {
        modelOpen.value = false;
        modeOpen.value = false;
        personaOpen.value = false;
        // The overflow closes with them: everything left inside it is one of the three panels the badge just greyed.
        moreOpen.value = false;
    }
});

// The composer's own clock, running only while a pick-up counts down to a named instant (an allowance reset);
// nothing else here is time-dependent.
const paneNow = useNow(() => pickUp.value?.readyAt !== undefined);
// What the next press means: one snapshot of the composer, read against composerIntent.ts's decision ladder. The
// pane only supplies the values only a mounted chat has.
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
    // The pick-up, read against the clock here — the pure ladder (PickUpSituation) must not ask what time it is.
    pickUp: pickUp.value === undefined ? undefined : { ready: pickUpReady(pickUp.value, paneNow.value) },
    queued: queued.value.length,
    connected: connected.value,
}));
const intent = computed(() => sendIntentOf(situation.value));
// Why Send is refusing, in the user's words; undefined when the press will land.
const refusal = computed(() => sendRefusal(situation.value));
// Two readings of one state: the strip says what happened, the offer is the press/Enter, sharing one predicate.
const continueStrip = computed(() => continueVisible(situation.value));
const continueOffer = computed(() => continueOffered(situation.value));
const canSend = computed(() => sendable(situation.value, intent.value, refusal.value));
// The row's end holds one primary button: Send survives a live turn since typed text always has somewhere to go,
// but an empty box mid-turn has none, so Stop takes the primary slot until the first keystroke. Gated on
// `staged`, not `canSend`, so a refused send with words in the box keeps its greyed button and tooltip.
const sendShown = computed(() => !streaming.value || staged.value);
// Everything a press needs: voice and edit intercept before `canSend`, and Enter reaches submit() directly.
const readyToSend = computed(() => connected.value && staged.value && refusal.value === undefined);

const words = computed(() => ({ provider: providerName.value, onTrial: onTrial.value, editDropped: editDropped.value }));
// A viewer's composer is present but inert (the daemon floors every route at collaborator); disabled-with-a-
// reason, since a vanished input reads as broken.
const { canDrive } = useRole();
const composerPlaceholder = computed(() => (canDrive.value ? placeholderFor(intent.value, words.value) : VIEWER_PLACEHOLDER));
const sendHint = computed(() => {
    if (!reachable.value) {
        return `The sandbox is busy: keep typing; Send is available when it is ready.`;
    }
    return refusal.value ?? sendHintFor(intent.value, words.value);
});
// Stop is offered for every live turn, including one parked on a card — the most common reason to want out;
// naming the consequence there (the parked request goes with it).
const stopLabel = computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`));
const stopHint = computed(() =>
    awaitingDecision.value ? `Stop the turn, discards the request above` : mobile.value ? stopLabel.value : `${stopLabel.value} (Esc)`,
);

// What will actually happen to the queued messages: a steerable turn has already been offered them (parked on a
// card), an unsteerable one ends first, and with nothing running they ride the next send.
const queuedHint = computed(() => {
    if (!streaming.value) {
        return `Sends with your next message`;
    }
    return awaitingDecision.value ? `Sends once you answer the request above` : `Sends when this turn ends`;
});

// The sandbox's recall ring (up/down/Escape); resolved per sandbox so switching sandboxes switches rings.
const history = computed(() => (activeSandboxId.value === undefined ? undefined : inputHistoryFor(activeSandboxId.value)));

// Makes the press (continueOffered); what it does is the conversation's call — re-runs a held turn or sends the
// shown sentence. Only a sent continuation joins the recall ring, since a re-run said nothing to want back.
const continueTurn = (options?: { readonly carry?: boolean }): void => {
    if (!reachable.value) {
        return;
    }
    void continueChat(options).then((sent) => {
        if (sent !== undefined) {
            history.value?.record(sent);
        }
    });
    pin();
};

// A tab/sandbox switch resets both rings, so down/Escape can't paste one tab's draft into another's.
watch([() => props.conversation, history], (_current, [, previousHistory]) => {
    previousHistory?.reset();
    history.value?.reset();
});

// Whether this draft sends as a command: matches the whole first word against published names (the popover
// matches only the typed token), the same rule the daemon applies on arrival. Only the true case is worth saying.
const commandRun = computed<AgentCommand | undefined>(() => {
    const text = draft.value.trimStart();
    if (!text.startsWith(`/`)) {
        return undefined;
    }
    const name = text.slice(1).split(/\s/, 1)[0] ?? ``;
    return availableCommands.value.find((command) => command.name === name);
});

// Who this chat is to the outside world: the pick lives on the conversation; the pane adds the card behind the id
// (the pill's name, the one state worth interrupting for). Read here since the answer is workspace-wide and
// cached.
const { personas: personaCards, isConnected: personaSignedIn } = usePersonas();
const pickedPersona = computed(() => personaCards.value.find((persona) => persona.id === props.conversation.actsAs.value));
const personaName = computed(() => pickedPersona.value?.label ?? pickedPersona.value?.id ?? props.conversation.actsAs.value);

// The one persona state the composer interrupts for, and only ever one the pill can't show on its own: a missing
// card is a warning (no accounts, no tools at all, since the daemon fails closed on an unresolved name).
const personaNotice = computed<string | undefined>(() => {
    const pinned = props.conversation.actsAs.value;
    if (pinned === undefined) {
        return undefined;
    }
    if (pickedPersona.value === undefined) {
        return `This chat acts as "${pinned}", which no longer exists: it would reach no account and no tools. Pick another persona.`;
    }
    // A card with no accounts is not a notice: it's a state the user chose and can see (still bounds and names the
    // turn), so nothing interrupts for it. What remains is the daemon-visible failure: an account that isn't signed in.
    return pickedPersona.value.capabilities.length === 0 || pickedPersona.value.capabilities.some((held) => personaSignedIn(held))
        ? undefined
        : `${personaName.value} isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`;
});

// Picking a persona no longer moves the chat between trees: every conversation already starts isolated, and a
// card's job is to say where it starts and what it may touch, not to undo that isolation.
const pickPersona = (id: string | undefined): void => {
    personaOpen.value = false;
    props.conversation.actsAs.value = id;
    // A pick by hand, "Anyone" included, overrules whatever the router had read into this chat.
    personaRoute.byHand();
    // The card's own model goes on with it, when it has one (Conversation.wearModel).
    const card = personaCards.value.find((persona) => persona.id === id);
    const head = card === undefined ? undefined : personaModels(card, roleSources.value)[0];
    if (head !== undefined) {
        props.conversation.wearModel(head);
    }
};

// Which persona the daemon reads the sent message as belonging to, asked once on a turnless, personaless chat
// (personaRoute.ts). `beforeSend` is the wait the send holds for, so the card is on for the turn that decides the
// conversation's tree; the chat says in its own transcript that the reading is happening.
const personaRoute = usePersonaRoute(() => props.conversation);

// Snaps the box back to one line and refocuses the cursor — what every path that spends the draft ends with.
const settleComposer = (): void => {
    draft.value = ``;
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

// Places the draft into the transcript as the agent's words. Awaited, unlike an ordinary send, since a refused
// place has no queue to fall into — the words either land in the record or stay in the box, never cleared on a
// refusal.
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

// Rewinds to the edited message and sends the box in its place (Conversation.submitEdit). The send is the
// confirmation: everything the edit destroys is destroyed here, and nowhere earlier — no second "are you sure" on
// top of it.
const sendEdit = (): void => {
    const replacement = draft.value.trim();
    void submitEdit(replacement, staging.snapshot(), editorContextForSend());
    attachments.value = [];
    includeEditorContext.value = false;
    history.value?.record(replacement);
    pin();
    settleComposer();
};

// The ordinary message: one path whether or not a turn is running (delivered or queued, Conversation.enqueue).
// Typing during a pending plan rejects it with the text as revision feedback instead.
const sendDraft = (): void => {
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    // Snapshots the chips onto the message, then clears without revoking preview URLs — the message now owns the
    // thumbnails.
    if (pendingPlan !== undefined) {
        void decidePlan(pendingPlan, false, text, staging.snapshot());
        attachments.value = [];
    } else {
        const snapshot = staging.snapshot();
        const editorContext = editorContextForSend();
        // A routed chat's opening message waits for the reading, so the card is on before the turn that decides the
        // tree; every other send goes now.
        const routing = personaRoute.beforeSend(text);
        if (routing === undefined) {
            void send(text, snapshot, editorContext);
        } else {
            void routing.then(() => send(text, snapshot, editorContext));
        }
        attachments.value = [];
        includeEditorContext.value = false;
    }
    // Both branches send `text` somewhere and earn a recall slot, except a bare queue-flush press, which sent no text
    // of its own.
    if (text.length > 0) {
        history.value?.record(text);
    }
    // Sending re-arms follow: writing the newest thing says the bottom is where the user wants to be.
    pin();
    settleComposer();
};

// The press, in the precedence the intents are named in: place and edit intercept and always return, since
// falling through with an empty box would misfire as Continue or an appended send. Then the run-through badge,
// then `canSend` for what's left.
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
    // Nothing typed and a turn left hanging means Continue (continueOffered); below the badges (explicit choices) and
    // above everything else, since every other gate reads a draft that doesn't exist here.
    if (continueOffer.value) {
        continueTurn();
        return;
    }
    sendDraft();
};

// Hands-free voice: the mic, and what the pause does (useComposerVoice); below `submit`, since the pause is the
// send.
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
// Leaving exits hands-free, so a mic isn't left recording a pane nobody's looking at; the draft is untouched.
watch([() => props.conversation, () => props.focused], quitVoice);

// The one hint slot under the composer: an empty box can't take a newline but can take a recall, so it advertises
// whichever is live.
const recallable = computed(() => draft.value === `` && history.value?.recallable === true);
const composerHint = computed(() => {
    // Live voice outranks everything below — while it's on, Escape means "catch the mic", not "stop streaming".
    const spoken = voiceSlotHint.value;
    if (spoken !== undefined) {
        return spoken;
    }
    // While generating, the shortcut worth the slot is the way out — the only place Escape's meaning is learned.
    if (streaming.value && !awaitingDecision.value) {
        return `Esc to stop`;
    }
    // A draft that runs as a command sends nothing to the model, so say so before Enter, not after.
    if (commandRun.value !== undefined) {
        return `Enter runs /${commandRun.value.name}`;
    }
    // The stopped turn's shortcut, in the slot the user is already reading while deciding what to type — the only
    // place anyone learns the key exists. Ranked ahead of the recall hint since it's rarer and more useful.
    if (continueOffer.value) {
        return `Enter to continue`;
    }
    return recallable.value ? `↑ for previous message` : `Shift+Enter for new line`;
});

// Mentions and commands: an @-token at the caret opens the file picker; a leading `/` with the caret still in the
// first token opens the command list. Escape dismisses until the token changes.
const caret = ref(0);
const syncCaret = (): void => {
    caret.value = input.value?.selectionStart ?? draft.value.length;
};
const onInput = (): void => {
    grow();
    syncCaret();
    // Typing reclaims a recalled draft as the user's own, discarding the stashed one; only real keystrokes reach here
    // (programmatic writes go through v-model with no input event), which is what lets typing catch an armed voice
    // send.
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
// Commands the typed token could still become; nothing to show closes the popover, not an empty one.
const commandMatches = computed<readonly AgentCommand[]>(() => {
    const needle = slashQuery.value?.toLowerCase();
    return needle === undefined ? [] : availableCommands.value.filter((command) => command.name.toLowerCase().includes(needle));
});
const mentionPopover = ref<InstanceType<typeof ChatMentionPopover>>();
const commandPopover = ref<InstanceType<typeof ChatCommandPopover>>();
// Not for a conversation in another box: the mention popover completes against this workspace's file tree, and a
// path it offers may not exist on the daemon being written to. Typing `@` there is just an ordinary character.
const mentionOpen = computed(() => activeMention.value !== undefined && !popoverDismissed.value && !remote.value);
const commandOpen = computed(() => !mentionOpen.value && commandMatches.value.length > 0 && !popoverDismissed.value);

// Asks for the command list only when this composer has none (ensureProviderCommands is a no-op once known),
// triggered by a provider switch or by typing `/` itself. Deliberately not inside `availableCommands`, since a
// fetch fired from a getter would refire on every re-evaluation.
watch(
    [provider, () => draft.value.startsWith(`/`)],
    ([target]) => {
        if (availableCommands.value.length === 0) {
            void ensureProviderCommands(target);
        }
    },
    { immediate: true },
);

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

// Message recall: puts a recalled message in the composer with the caret at its end, ready to send or edit.
const recallInto = (text: string): void => {
    applyDraftEdit(text, text.length);
    // A recalled message is complete: autocomplete mustn't reopen over it; dismissed on the next tick.
    void nextTick(() => {
        popoverDismissed.value = true;
    });
};

// True when recall consumed the key (recallStep says which); claims nothing while text is selected, since arrows
// are collapsing a selection, not navigating. Reads the live element, not the `caret` ref, which goes stale under
// an auto-repeating arrow.
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
    // The step lands on an edge past max-h-48's scroll; without this the caret would leave the visible rows.
    el.scrollTop = step.at === 0 ? 0 : el.scrollHeight;
    return true;
};

// The composer's keyboard: both popover lists answer the same three gestures, and nothing else.
interface PopoverList {
    readonly move: (delta: number) => void;
    /** Whether a row was actually picked: with none active, the key belongs to the composer. */
    readonly pickActive: () => boolean;
}
const activePopover = computed<PopoverList | undefined>(() =>
    mentionOpen.value ? mentionPopover.value : commandOpen.value ? commandPopover.value : undefined,
);
// An open popover owns the list keys; unclaimed keys fall through, so Shift+Enter still inserts a newline.
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

// Escape interrupts only while generating; a card-parked turn spends nothing, so Stop is the way out instead.
const interruptible = computed(() => streaming.value && !awaitingDecision.value && reachable.value);
// Who gets Escape, after popovers and recall have had their claim: voice catches a counting-down send and quits
// hands-free; an armed edit is simply abandoned (free — nothing changed); only then does it reach the
// streaming-turn stop.
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
    // After the popovers: an open @/-list owns the arrows, and recall's Escape mustn't pre-empt dismissing it.
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

// This pane's half of "New agent" (agentActions.startAgent opens the tab and asks for the caret): only the
// focused pane answers, since the signal names no conversation and the tab that was just opened took focus.
watch(composerFocus, () => {
    if (!props.focused) {
        return;
    }
    void nextTick(() => {
        grow();
        const field = input.value;
        field?.focus();
        // A composer that arrives already filled (a board starter's suggestion, left mid-sentence) keeps the caret
        // where
        // the sentence stops, not in front of it; a no-op on every other, empty-draft summons.
        field?.setSelectionRange(field.value.length, field.value.length);
    });
});

// Lifecycle: one idle-time realization pass after a transcript lands wholesale, so the scrollbar height is honest
// (useTranscriptWarmup).
const { realizing } = useTranscriptWarmup({
    conversationId: computed(() => props.conversation.conversationId),
    messageCount: computed(() => messages.value.length),
    streaming,
});

// A different transcript on screen starts at its newest message — the one place that states this, rather than
// every press that reaches it (tabs, history, the board, /agents/:id, a closed neighbour tab). Post-flush so the
// new transcript is in the DOM to scroll to; later growth is handled by follow's own pin.
watch(
    () => props.conversation.conversationId,
    () => {
        pin();
        grow();
    },
    { flush: `post` },
);

// Follows the transcript on length/streaming changes rather than trusting the composable's resize observations,
// which the browser can coalesce or defer past the layout that produced them, leaving new content below the fold.
// O(1), post-flush, so the row exists to scroll to.
watch([() => messages.value.length, streaming], follow, { flush: `post` });

// Focuses the composer once connected, sized to any restored draft; skipped on mobile (autofocus would pop the
// keyboard unasked) and in an unfocused pane (would steal the caret).
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
    <!--
        Everything the panel's chat list is not; carries the @container so composer density keys off this pane's own
        share of the width, not the panel's.
    -->
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
        <!--
            Floats over the transcript's corner rather than a header, since a pane has no header of its own and the panel
            above already names the chats. Muted at rest so it doesn't compete with the conversation; stops
            pointerdown/focusin so closing an unfocused pane never flashes focus onto it.
        -->
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
        <!--
            One scroller for the transcript and the composer under it, so the composer's height is reserved by layout, not
            measured back into it — the composer sticks to the bottom and the transcript is always readable clear of it.
            The insets live on the inner wrapper (the ResizeObserver target), not the scroller, since a sticky element
            resolves against the scroller's padding edge.
        -->
        <!--
            `.chat-scroller` is the IntersectionObserver root each prompt uses to tell if it's pinned. Vertical only: a
            sideways scrollbar dragging the whole panel is always a bug; code blocks and tables carry their own horizontal
            scroller (prose.css).
        -->
        <div
            ref="scroller"
            class="chat-scroller scrollbar-thin flex flex-1 flex-col overflow-x-hidden overflow-y-auto"
            :class="{ 'chat-realize': realizing }"
        >
            <div ref="content" class="flex min-w-0 flex-1 flex-col">
                <div class="chat-turns flex flex-1 flex-col pt-4">
                    <!--
                        The rest of the conversation, above the window it opened on (a long chat starts mid-history); drawn only where
                        more exists. Styled like the day marker, not an action, since it's a statement about where the reader is that
                        happens to be pressable.
                    -->
                    <div v-if="conversation.historyMore.value" class="flex justify-center py-2">
                        <!--
                            The press is the words, not the row — a full-width button would light up on any pointer crossing the top with
                            no visible edges.
                        -->
                        <button
                            type="button"
                            class="cursor-pointer text-2xs text-subtle transition-colors hover:text-content disabled:cursor-default disabled:text-subtle"
                            :disabled="conversation.loadingOlder.value"
                            @click="conversation.loadOlder()"
                        >
                            {{ conversation.loadingOlder.value ? `Loading earlier turns…` : `Load earlier turns` }}
                        </button>
                    </div>
                    <!--
                        Where a forked chat says so, above its inherited turns; held back until the reader reaches that point, or it
                        would misname the fork's true start over a window that begins mid-history.
                    -->
                    <ChatForkLine v-if="!conversation.historyMore.value" />
                    <template v-if="messages.length > 0">
                        <!--
                            One section per turn, so each prompt's sticky range ends where its own answer does; a bare "continue" or app
                            errand folds into the turn it serves (foldsIntoTurn).
                        -->
                        <!-- `index` is for the day marker below, the one row that cares about its column position, not its turn. -->
                        <template v-for="(turn, index) in turns" :key="turn.id">
                            <!--
                                The day this stretch was sent, drawn only where the date changes (dayMarks), between sections rather than
                                inside one (a boundary, not part of a turn). No rule across the column, since that would fence turns apart.
                                Weighted above, since the marker belongs to what follows it.
                            -->
                            <div
                                v-if="dayMarks.get(turn.id)"
                                class="flex justify-center pb-0.5 text-2xs text-subtle"
                                :class="index === 0 ? '' : 'pt-3'"
                            >
                                {{ dayMarks.get(turn.id) }}
                            </div>
                            <section class="chat-stack group/turn relative flex flex-col">
                                <!--
                                    v-memo skips a row whose listed inputs are unchanged — during streaming, every row but the one being written —
                                    since `turns` rebuilds on every paint. The key lists exactly what the row renders from.
                                -->
                                <!-- `doomed` joins the memo key for the same reason: a just-struck (or un-struck) row renders differently. -->
                                <!--
                                    A `display: contents` wrapper so its children are the section's own flex items, spaced on the same gap as when
                                    the row was the loop's direct element; needed because a row can now be preceded by a mark (cutsAbove) and
                                    `v-memo` must sit on the `v-for` element itself. `cutAbove` joins the memo key for the same reason as `doomed`.
                                -->
                                <div
                                    v-for="message in turn.messages"
                                    :key="message.id"
                                    v-memo="[
                                        message,
                                        isStreaming(message),
                                        turn.folded,
                                        doomed.has(message.id),
                                        cutsAbove.get(message.id),
                                        repeatedChecklists.has(message.id),
                                    ]"
                                    class="contents"
                                >
                                    <!--
                                        The way back to just above this message, for boundaries one mark per turn can't reach (a folded message,
                                        cutsAboveOf). Between rows, not inside one: `.chat-message` paint-contains via `content-visibility: auto`,
                                        which clips a mark hanging above its top edge out of existence.
                                    -->
                                    <ChatForkCut v-if="cutsAbove.get(message.id) !== undefined" :cut="cutsAbove.get(message.id)!" />
                                    <ChatMessageView
                                        v-if="!repeatedChecklists.has(message.id) || isStreaming(message)"
                                        :message="message"
                                        :streaming="isStreaming(message)"
                                        :folded="message.id === turn.id ? turn.folded : undefined"
                                        :doomed="doomed.has(message.id)"
                                    />
                                </div>
                                <!--
                                    The fork point of this turn, in the column's margin at the end of the answer: everything above is what a fork
                                    keeps. Last in the section so it sits level with the close of the answer, and inside it so it hangs off the
                                    turn's own hover.
                                -->
                                <ChatForkCut :cut="forkCuts.get(turn.id) ?? messages.length" />
                            </section>
                        </template>
                    </template>
                    <!--
                        The transcript is on its way (a history open, an empty local mirror); without this it briefly reads as data
                        loss, not loading.
                    -->
                    <ChatTranscriptSkeleton v-else-if="activeLoading" />
                    <!--
                        Names the provider because that's the fact worth having on every provider but the trial, where the reader
                        connected nothing and a provider name would only raise a question.
                    -->
                    <p v-else class="m-auto max-w-[80%] text-center text-xs text-muted">
                        {{ onTrial ? `Ask anything, this chat is free and needs nothing connected.` : `Start a conversation with ${providerName}.` }}
                    </p>
                    <!--
                        The live turn before it's written anything (showTurnStatus); outside the turn sections since it belongs to no
                        message yet.
                    -->
                    <ChatTurnStatus v-if="showTurnStatus" />
                    <p v-if="activeError" class="text-xs text-danger">{{ activeError }}</p>
                </div>

                <!--
                    The composer and its gating notices; last row of the transcript, stuck to the bottom edge, rather than a
                    separate band, so the only surface is the composer's own box (transcript slides under it once scrolled). A
                    touch wider than the reading column, capped for the floating window where full-width would be a very long line.
                -->
                <div ref="footer" class="chat-footer sticky bottom-0 z-10 mx-auto flex w-full max-w-[51rem] flex-col gap-2 px-2 py-3">
                    <!--
                        The only two states with no composer to explain itself; a merely-busy sandbox is not one of them (that's said
                        once, in the notification lane — Send's own tooltip explains why it's dark). In flow, not floating, since this
                        is about one pane among several.
                    -->
                    <Notice v-if="denied" tone="danger">This Google account has no access to this sandbox, so chat is unavailable.</Notice>
                    <Notice v-else-if="blocked" tone="info" icon="clock">Chat is available after this sandbox finishes setup.</Notice>
                    <template v-if="!blocked">
                        <!--
                            This chat's standing: archived, the account gate, the trial, a credential to renew, an outage resuming
                            (ChatPaneNotices).
                        -->
                        <ChatPaneNotices />
                        <!--
                            The turn stopped before finishing, and the way on (ChatContinueStrip). Above the queue, since this is what
                            becomes of the stopped turn and the queue is what goes next either way.
                        -->
                        <ChatContinueStrip :visible="continueStrip" :ready="continueOffer" @continue="continueTurn" />
                        <template v-if="connected">
                            <!--
                                Messages written while busy that haven't reached the agent yet; they sit here, not in the transcript, until the
                                agent actually takes one. Each is removable before it lands.
                            -->
                            <div v-if="queued.length > 0" class="flex flex-col gap-1">
                                <div
                                    v-for="message in queued"
                                    :key="message.id"
                                    class="flex items-start gap-2 rounded-xl border border-dashed border-line-strong bg-card px-3 py-2"
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
                            <!--
                                An edit in flight, said directly over the box being typed into: the struck rows above are the count, this is
                                the label, which message and the two ways out. Last of the strips, closest to the box, since only this one
                                describes what the box itself is now for; in the accent, since it's a mode the user armed.
                            -->
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
                                <!--
                                    The way out that keeps the answer, deliberately before Cancel — the offer answering the hesitation should be
                                    read first.
                                -->
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
                            <!--
                                The whole box changes standing when the agent's voice is armed (.composer-voice); being in this mode by
                                accident is the one mistake worth painting.
                            -->
                            <form
                                class="ui-field-shell composer-frame relative flex flex-col rounded-2xl border-line-strong bg-overlay shadow-lg"
                                :class="{ 'composer-voice': voiceAgent }"
                                @submit.prevent="submit"
                            >
                                <ChatMentionPopover v-if="mentionOpen" ref="mentionPopover" :query="activeMention?.query ?? ''" @pick="pickMention" />
                                <ChatCommandPopover v-if="commandOpen" ref="commandPopover" :commands="commandMatches" @pick="pickCommand" />
                                <div v-if="attachments.length > 0 || editorChip" class="flex flex-wrap gap-2 px-3 pt-3">
                                    <!--
                                        Editor-context chip: off by default, one click attaches the open file/selection (inverse of VSCode Claude
                                        Code).
                                        Absent on a conversation in another sandbox, since the file it names is open in this workspace, not that
                                        daemon's.
                                    -->
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
                                        <!--
                                            By path, like every other thumb: staging a file keys its object URL to its path, so this chip and the
                                            sent
                                            bubble read the same one.
                                        -->
                                        <ChatImageThumb
                                            v-if="attachmentPreview(a.path)"
                                            :src="attachmentPreview(a.path) ?? ''"
                                            :alt="a.name"
                                            size="h-9 w-9"
                                        />
                                        <Icon name="file" v-else class="text-sm text-subtle" />
                                        <span class="max-w-36 truncate text-content" v-tooltip.top="a.error ?? a.name">{{ a.name }}</span>
                                        <!--
                                            The chip's own state in a glyph — the progress hairline is invisible once full, so an uploading chip
                                            wouldn't
                                            otherwise say why Send is disabled.
                                        -->
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
                                <!--
                                    Body tier on desktop: what you type reads at the size it lands in the transcript; text-base below md, since
                                    16px is the iOS zoom-on-focus threshold.
                                -->
                                <textarea
                                    ref="input"
                                    rows="1"
                                    v-model="draft"
                                    name="draft"
                                    :disabled="!canDrive"
                                    :placeholder="composerPlaceholder"
                                    class="field-bare scrollbar-thin block w-full resize-none overflow-y-auto px-4 py-3 leading-relaxed md:text-xs"
                                    :style="{ maxHeight: `${composerCap}px` }"
                                    @input="onInput"
                                    @keydown="onKeydown"
                                    @keyup="syncCaret"
                                    @click="syncCaret"
                                    @paste="staging.onPaste"
                                ></textarea>

                                <!--
                                    The control row wraps as two whole groups (brain: model/effort; shape+press) rather than clipping — a single
                                    row ran off-screen at the docked column's old width. `ml-auto`, not `justify-between`, so the second group
                                    holds the right edge whether or not it has wrapped onto its own line. What the row holds is now a fact about
                                    this chat: four shaping controls show only off their default, sitting in the overflow otherwise
                                    (composerMore.ts).
                                -->
                                <div class="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2.5 pb-2.5">
                                    <!--
                                        Model/effort/mode/persona go inert under a workflow badge because a workflow send makes no turn on this
                                        conversation — each step runs its own session on its own settings. Dimmed, not hidden: they still say what an
                                        ordinary send would use, and the badge is one press from handing them back.
                                    -->
                                    <!--
                                        `min-w-0` lets the model name truncate first, since it's the one shrinkable middle in the row. Both labels
                                        come
                                        back together at one shared breakpoint (`@max-lg`) sized to the wider requirement, so widening the column
                                        can't
                                        make the row grow taller. The chips to the right are not on this breakpoint: they keep their word at every
                                        width, since they're only in the row while set to something other than the default.
                                    -->
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

                                        <!--
                                            The tier judge's pre-send answer, shown only when the turn is really about to move (simple draft,
                                            auto-tier on,
                                            a cheaper rung available; nothing in Measure mode). Sits with the model group since it's a sentence about
                                            exactly that pill, keeping its glyph at every width and dropping only its words.
                                        -->
                                        <ComposerTierChip :conversation="conversation" />
                                    </div>

                                    <!--
                                        How the turn is shaped, and the press that sends it — the group holding the right edge. Wraps internally (the
                                        one exception to the outer row's rule) since its members are word-carrying chips that can outgrow even a
                                        narrow
                                        column when several are armed at once; `justify-end` keeps overflow lines against the edge with Send.
                                    -->
                                    <div class="ml-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1.5">
                                        <!--
                                            Mode's slot in an order that gradients away from the model (brain, then how it works, where it runs, who
                                            it is,
                                            what it runs through, whose words) that a chip must never break by appending itself. Mode sits closest to
                                            effort since the two are one thought: how hard it thinks, how much rope it has.
                                        -->
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

                                        <!--
                                            Where it runs — the one control about the machine, not the message; hidden until there's somewhere else
                                            to
                                            choose, read-only once the conversation has run (ChatPlacementMenu). Deliberately not on the promotion
                                            rule: it's
                                            checked before nearly every send, so it keeps its slot regardless.
                                        -->
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

                                        <!--
                                            Persona: who the chat is to the outside world. Only ever shown when it's somebody (composerMore.ts) —
                                            unset, it
                                            was a bare glyph on every chat announcing "nobody in particular"; set, it must be unmissable, in the
                                            active
                                            tint. Absent on a chat in another sandbox, since the persona id names nothing there and the send drops
                                            it.
                                        -->
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
                                            <!--
                                                Wears the persona's own face, falling back to the glyph only for a missing card; the name rides
                                                beside it at
                                                every width, unlike the pills either side, since it's here to say something about the next send.
                                            -->
                                            <PersonaFace v-if="pickedPersona !== undefined" :persona="pickedPersona" :size="16" />
                                            <Icon v-else name="users" class="text-2xs text-link" />
                                            <span class="max-w-32 truncate">{{ personaName }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </button>

                                        <!--
                                            Run-through: one control replacing two, since a loop and workflow answer the same question with answers
                                            the
                                            composer can only take one of. Armed, it wears the chosen thing's own icon and name in the active tint;
                                            unarmed
                                            it sits mute in the overflow. A running loop takes it over entirely and outranks even an armed workflow,
                                            since
                                            stopping something already running isn't a next-message decision.
                                        -->
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

                                        <!--
                                            Voice: the box is writing the agent's words, not yours — the next Send places the draft into the
                                            transcript
                                            with no reply, then disarms. Last of the shaping chips, nearest Send, since it changes what Send is more
                                            than
                                            anything else. Armed-only: off, it's a named overflow row; on, it's the one piece of the composer's
                                            changed
                                            standing a reader can press to take back.
                                        -->
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

                                        <!--
                                            The overflow: every shaping control sitting at its default, each a named row with its current value and a
                                            sentence — strictly more readable than the bare glyph it replaces. Nothing hidden here is doing anything;
                                            a
                                            control set to something else has left for a chip on the left. Last of the shaping controls, immediately
                                            before
                                            the mic, so it holds one fixed spot while chips beside it come and go.
                                        -->
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

                                        <!--
                                            Hands-free voice: one tap arms it, and the pause is the send (useComposerVoice). Every browser gets it —
                                            the
                                            transcription runs sandbox-side, gated only on the viewer role, which can't send at all.
                                        -->
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

                                        <!--
                                            Stop covers the whole live turn, including one parked on a plan/question/permission card — the most
                                            common
                                            reason to want out, since a parked turn still holds the run lock. Fixed before Send in the row so the two
                                            never
                                            trade places under a finger.
                                        -->
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
                                        <!--
                                            Send stays alongside Stop for as long as there's a message to send (mid-turn text is delivered or
                                            queued); an
                                            empty box mid-turn hands the slot to Stop instead (`sendShown`).
                                        -->
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
                            <!--
                                What the badge changes about the press, said under the box about to do it: the message goes to a design, not
                                this chat. Names itself here since the greyed pills' hover won't reach a touch device.
                            -->
                            <p v-else-if="pickedWorkflow" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="sitemap" class="shrink-0 text-2xs text-link" />Send starts "{{ pickedWorkflow.name }}": this message is
                                what every step is asked to do. Model, effort, mode and looping are each step's own.
                            </p>
                            <!--
                                The loop badge's own sentence carries the stop condition, not just the name, since this is the one badge whose
                                press keeps spending after the user looks away.
                            -->
                            <p v-else-if="runThroughState === 'loop' && pickedLoop" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="repeat" class="shrink-0 text-2xs text-link" />Send loops this message until it's met: ends on
                                {{ loopDesignLine(pickedLoop) }}.
                            </p>
                            <!--
                                A persona that can't do what the pill implies, said where the message is written rather than discovered on an
                                empty-handed turn — only for states the pill itself can't show.
                            -->
                            <p v-else-if="personaNotice" class="flex items-center gap-1.5 px-1 text-2xs text-warning">
                                <Icon name="exclamation-circle" class="shrink-0 text-2xs" />{{ personaNotice }}
                            </p>
                        </template>
                    </template>
                </div>
            </div>
        </div>

        <!--
            The pane's status bar, the one part of the footer outside the scroller: it's about the pane (context,
            subscription, daemon liveness), not the message, so it sits on the panel's own background rather than needing a
            surface to stay legible. The block slot carries only the refusal — a transport blip has its own home in the
            notification lane, not blinking under the composer.
        -->
        <ChatPaneStatus v-if="connected" :block="refusal" :hint="composerHint" />

        <!--
            The four composer menus, each in the app's standard desktop-panel/mobile-sheet swap (ResponsiveOverlay),
            uncapped in height: each measures the room in the pill's own window, so a picker fits whether this pane is
            docked or floating.
        -->
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
        <!--
            The overflow itself; its rows hand off to the three panels above, which then open over this same button so the
            choice is still made in the one list that owns it.
        -->
        <ResponsiveOverlay v-model="moreOpen" :anchor="morePill" cross="end" header="This message" panel-class="w-80 p-1">
            <ComposerMoreMenu :rows="moreRows" @pick="openFromMore($event)" />
        </ResponsiveOverlay>
    </div>
</template>
