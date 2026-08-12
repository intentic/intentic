<script setup lang="ts">
import { Icon, type IconName, ResponsiveOverlay, useDevice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, nextTick, onBeforeUnmount, provide, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
    type AgentCommand,
    isTrialProvider,
    type LoopDesign,
    loopDesignLine,
    loopFromDesign,
    providerLabel,
    TRIAL_NOTICE,
    type Workflow,
} from "@intentic/sandbox-contract";
import { trialExhausted } from "../composables/chat/access";
import { turnInFlight } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { useWorkflowRuns } from "../composables/agents/useWorkflowRuns";
import { openRunInChat } from "../composables/chat/openRun";
import { modeMeta } from "../composables/chat/catalog";
import type { Conversation, PendingAttachment } from "../composables/chat/conversation";
import { effectiveAccount } from "../composables/chat/providerAccounts";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { type ChatAttachment, type ChatMessage, dayMarksOf, forkCutsOf, turnsOf } from "../composables/chat/transcript";
import { formatReset, formatUtilization, formatWait, planHeadroom, SPENT_PERCENT, usageStatusFor } from "../composables/chat/usageStatus";
import { withShortcut } from "../composables/commands/useCommands";
import { useLoadingReveal } from "../composables/loadingReveal";
import { conversationView, hydrateOnce, PANE_VIEW, useChat } from "../composables/chat/useChat";
import { CHAT_SURFACE } from "./chatSurface";
import { workspaceSurface } from "./workspaceSurface";
import { usePersonas } from "../composables/sandbox/usePersonas";
import { useRole } from "../composables/sandbox/useRole";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useSpeechInput } from "../composables/chat/useSpeechInput";
import { useStickToBottom } from "../composables/chat/useStickToBottom";
import { sandboxJson, sandboxUpload } from "../composables/sandbox/sandboxClient";
import { jsonBody } from "../composables/sandbox/jsonBody";
import { useEditorSelection } from "../composables/workspace/useEditorSelection";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { collectDroppedFiles } from "../pages/workspace/dropEntries";
import { inputHistoryFor, recallStep } from "../composables/chat/inputHistory";
import { insertMention, mentionQueryAt } from "../composables/chat/useMentions";
import ChatAccountPanel from "./ChatAccountPanel.vue";
import ChatCommandPopover from "./ChatCommandPopover.vue";
import ChatImageThumb from "./ChatImageThumb.vue";
import ChatMentionPopover from "./ChatMentionPopover.vue";
import ChatForkCut from "./ChatForkCut.vue";
import ChatForkLine from "./ChatForkLine.vue";
import ChatMessageView from "./ChatMessageView.vue";
import ChatModelPicker from "./ChatModelPicker.vue";
import ChatModeMenu from "./ChatModeMenu.vue";
import ChatPersonaMenu from "./ChatPersonaMenu.vue";
import ChatRunThroughMenu from "./ChatRunThroughMenu.vue";
import { useLoopDesigns } from "../composables/agents/useLoopDesigns";
import { startLoop, stopLoop } from "../composables/agents/useLoops";
import ChatTranscriptSkeleton from "./ChatTranscriptSkeleton.vue";
import { formatTokens, ProgressRing } from "@intentic/ui";
import ComposerEffort from "./ComposerEffort.vue";
import ComposerModelPill from "./ComposerModelPill.vue";
import UsageRing from "../components/UsageRing.vue";

/* ONE CHAT ON SCREEN — the transcript, the composer that writes into it, and the pickers and banners that
 * belong to that one conversation. The panel around it (ChatPanel) owns the frame: the chat list, the pop-out,
 * the resize handle, the shell-wide commands. Several of these stand side by side in a popped-out window.
 *
 * IT TAKES ITS CONVERSATION RATHER THAN READING THE FOCUSED ONE, which is the whole reason it is a component:
 * every value on screen here — what the composer sends, which model the pill names, whose plan the card
 * approves — has to be this pane's, not whichever chat happens to hold the focus. The facade over it
 * (conversationView) is built once here and PROVIDED, so the transcript rows and their tool cards four levels
 * down answer for the same chat without threading a prop through everything in between.
 *
 * The column is a @container: composer/status label density keys off the width the messages get (288px docked
 * while the viewport is desktop-wide, or this pane's share of the pop-out window), while touch-target sizing
 * keys off the max-md: device class. Two intentional axes — don't unify them. */

const props = defineProps<{
    conversation: Conversation;
    // Whether this is the pane the keyboard is acting on. Only the focused pane answers the shell's "put the
    // caret in the composer" signal — with several panes open, every one of them answering would move the
    // caret to whichever mounted last.
    focused: boolean;
    // Whether this pane's column can be given back — true in a split, where taking one column back still
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

// Working in a pane is what focuses it — a click anywhere in it, or the caret arriving by any other route
// (Tab, a picker closing). The panel answers by moving the focus, which is a store write, so it is only
// raised by a pane that does not already hold it: every click in the focused pane would otherwise re-seat a
// focus that had not moved and scroll the rail to it.
const emit = defineEmits<{ focus: []; close: [] }>();
const takeFocus = (): void => {
    if (!props.focused) {
        emit(`focus`);
    }
};

// The corner ×, and what it is careful to say: this ends the COLUMN, not the conversation — the chat is still
// in the rail, one click from a column again. The chord it duplicates (chat.closePane) acts on the FOCUSED
// pane, so only the focused pane's button teaches it; on any other, naming a key that would close a different
// column is worse than naming none.
const CLOSE_PANE = `Close this pane — the chat stays open`;
const closeHint = computed(() => (props.focused ? withShortcut(CLOSE_PANE, `chat.closePane`) : CLOSE_PANE));

const paneView = conversationView(computed(() => props.conversation));
provide(PANE_VIEW, paneView);
const {
    messages,
    streaming,
    awaitingDecision,
    pendingPlanMessage,
    resumable,
    continuation,
    contextUsage,
    mode,
    provider,
    account,
    accounts,
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
        navigate: (route) => void router.push(route),
    }),
);
const { poppedOut } = useChatPopout();
const { activeSandboxId, reachable, connection } = useSandbox();
// The daemon refused this Google account outright — a different sentence than "not connected yet", because
// waiting will not fix it.
const denied = computed(() => connection.value.failure?.kind === `forbidden`);
const { mobile, keyboardInset } = useDevice();

// Pill labels — rendered as our own text (not a PrimeVue Select); always a real model name. The option
// catalogs live in the contract's agent-catalog.ts (shared with the automations dialog) and chat/catalog.ts.
const providerName = computed(() => providerLabel(provider.value));
// The chip's model name: shared with the picker menu so they can't drift; falls back to the provider name (never
// blank) while Grok's daemon catalog is still loading.
const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));
/* NEITHER PILL CARRIES A HOVER LABEL. The model pill's said the provider's name — which its own logo is
 * already there to say — and the mode pill's said the mode's description, which the menu one click below
 * prints under every mode including the one in force. Two boxes that opened over the composer to repeat what
 * was under them, on the two controls a hand rests on most while writing.
 * What the model's hint alone could say is gone with it: a turn RUNNING a different model than the one
 * selected (a fallback, or a provider alias) had no other home. That belongs on the turn, not on a hover of a
 * control that describes the NEXT one. */
const scroller = ref<HTMLElement>();
const content = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
// The pickers: ONE open flag per menu, whichever surface renders it — an anchored panel on desktop, a bottom
// sheet on mobile, which ResponsiveOverlay picks between. One flag, not one per surface: the pair drifted apart
// once already, with the close-on-disconnect watch below reaching only the desktop half. The PILL is what says
// which window a desktop panel opens in — it is the anchor, and the overlay derives the document, the viewport
// it measures against and the dismissal listeners from it. That is the whole reason this panel can be popped
// out into a real window and still have overlays that land in the right place and close when clicked away from.
const modelOpen = ref(false);
const modeOpen = ref(false);
const runThroughOpen = ref(false);
const personaOpen = ref(false);
const modelPill = ref<InstanceType<typeof ComposerModelPill>>();
const modePill = ref<HTMLElement>();
const runThroughPill = ref<HTMLElement>();
const personaPill = ref<HTMLElement>();

// Auto-follow: the transcript stays at its newest content unless the user has scrolled up to read. The rule
// and every geometry change it has to survive live in the composable; the pane only says when a NEW
// transcript is on screen (the conversationId watch below), when the user has just sent something (submit),
// and — because the composable watches these boxes with an observer owned by the window they are in — when
// they move to another one, which for this pane is the pop-out and back.
const { pin, follow } = useStickToBottom(scroller, content, poppedOut);

// The window this pane's rows are painted in — the pop-out's whenever the panel has one. Asked of the scroller
// afresh at each use, since a pop-out or a dock can land between two steps of the same pass.
// Undefined only when there is no window to be had at all — the pane's scroller is gone AND so is the global.
// That is a torn-down document, which happens between a deferred callback being queued and it running (a
// unit test's environment closing under an idle task; a pop-out closed mid-pass). `globalThis.window` rather
// than a bare `window`, because the bare identifier THROWS where the property merely reads undefined.
const transcriptWindow = (): (Window & typeof globalThis) | undefined => scroller.value?.ownerDocument.defaultView ?? globalThis.window;

const activeError = computed(() => props.conversation.error.value);
/* This conversation's transcript round-trip, still in flight with nothing painted yet — the empty state
 * defers to a loading one on it. Gated by useLoadingReveal, not read raw: a warm daemon answers this in well
 * under the time it takes to read a placeholder, and an outline that appears for one beat and vanishes is a
 * glitch, not feedback. Keyed on the conversation so switching tabs mid-load drops the outline at once instead
 * of holding it over a different chat. */
const activeLoading = useLoadingReveal(
    computed(() => props.conversation.loading.value),
    computed(() => props.conversation.conversationId),
);

// This conversation's account when its stored credential can no longer be refreshed — surfaced as a
// pre-send banner so the user reconnects before hitting an opaque failure mid-turn (Codex today).
const activeAccountReauth = computed(() => {
    const id = account.value ?? accounts.value[0]?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});

/* What the trial strip above the composer says, or nothing at all when this conversation isn't on the trial.
 *
 * Two sentences, because there are two states worth interrupting for and they want opposite things from the
 * reader. While there is allowance left the message is the DISCLOSURE — these messages pass through intentic —
 * which the user needs before typing, not after. Once it is spent the disclosure is moot and the only useful
 * sentence is where to go next, which is the free Google sign-in: no daily cap, still no subscription. */
const trialNotice = computed(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    return trialExhausted(provider.value)
        ? `Free trial used up for today. Connect a Google account to keep going free — no subscription, no daily cap.`
        : TRIAL_NOTICE;
});

/* The outage banner (Conversation.failures.outageResume). A spent usage limit gets no equivalent: it has a known reset
 * instant and nothing anyone can do before it, so the transcript notice naming that instant says everything
 * there is to say. An outage has no known end, which is why it needs a live banner — its whole job is to answer
 * "is anything still happening?", which during an outage is the only question anyone has. When auto-resume is
 * off it is instead the offer to turn it on, which arms the very turn that bounced (the daemon remembered it
 * either way). */
const { settings: sandboxSettings, save: saveSandboxSettings } = useSandboxSettings();
const outageResume = computed(() => props.conversation.failures.outageResume.value);
const enableOutageResume = async (): Promise<void> => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    await saveSandboxSettings.mutateAsync({ ...current, resumeAfterOutage: true });
    props.conversation.failures.armOutageResume();
};

/* Archiving an agent closes its chat tab (see the archive note in useAgents), but an archived agent can still be
 * READ in a tab — opened from the archive view, or filed away by the daemon's retention sweep while it sat open.
 * Such a tab must not look live, so the pane says the agent is off the board and offers the one press back. The
 * line also spends its second half on the fact nothing else here could tell the user: a message sent from this tab
 * un-archives the agent (the daemon rebuilds the entry without its marker — registry.begin), which is a
 * feature, not a surprise to walk into.
 *
 * Archived agents ride their own list rather than the live roster, so it has to be asked for. On the REACHABLE
 * seam, not at setup: this pane mounts with the shell, long before the daemon is answering, and a read fired
 * then simply fails — leaving every archived tab in the app looking live until the user happened to open the
 * board. Only while the list is empty, so the one request is not repeated per reconnect once it has landed. */
const { agentById, archived, loadArchived, restore, busyIds } = useAgents();
watch(
    reachable,
    (live) => {
        if (live && archived.value.length === 0) {
            void loadArchived();
        }
    },
    { immediate: true },
);
const activeArchived = computed(() => {
    const agent = agentById(props.conversation.conversationId);
    return agent?.archivedAt === undefined ? undefined : agent;
});

/* THE PANE FOLLOWS THE FLEET — the missing half of "the chats fill a second later" (chatRun's promise about a
 * workflow's derived conversation ids). A run's panes open on conversations the daemon has not created yet,
 * and every read such a tab makes is one-shot: the transcript fetch 404s, the attach probe finds no run, and
 * nothing ever asks again — so a pane that lost that race stayed blank while the daemon streamed the whole
 * step into a record nobody re-read. The roster rides the /events stream, so it answers in real time what the
 * one-shot reads cannot: this conversation now exists, its turn began, its turn settled. Any change in that
 * answer, for a pane that is not itself streaming, means the daemon knows something this tab does not — bring
 * the tab up to date (hydrate attaches to a live turn and reconciles a settled one against the record).
 *
 * Primitive-valued, so the roster's full-snapshot republishing only fires the watch on an actual transition.
 * `undefined` (not on the roster) changes nothing a read could improve and touches nothing: an agent swept off
 * the roster is still an agent, and a pane must not react to the sweep. */
const fleetTurn = computed<boolean | undefined>(() => {
    const agent = agentById(props.conversation.conversationId);
    return agent === undefined ? undefined : turnInFlight(agent);
});
// Whether this tab itself streamed the turn the roster will settle next — its transcript already holds the
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
        // A turn this tab is not streaming just began — whatever the flag remembers is about an older one.
        streamedTurn = false;
    }
    // The roster listing this conversation IS the registration fact — heal a tab whose early probe took the
    // daemon's "unknown agent" for a final answer (replayStoredSession's unlatch), asked before the run's
    // first turn created the entry.
    props.conversation.registered.value = true;
    hydrateOnce(props.conversation);
});

/* THE LOOP HALF OF THE RUN-THROUGH BADGE. The badge itself (states, glyph, what a press means) is assembled
 * further down with the workflow half, because the two are one control; what lives here is what only a loop
 * has — the fleet entry behind a RUNNING one, and the stop.
 *
 * Two things are read off that entry rather than asked anywhere: whether this agent works in its own worktree
 * (a loop cannot change that mid-flight), and whether one is already running (the daemon refuses a second, so
 * offering one would only spend a round to say no).
 */
const activeLoop = computed(() => agentById(props.conversation.conversationId)?.loop);
const looping = computed(() => activeLoop.value?.state === `running`);
const loopIsolated = computed(() => agentById(props.conversation.conversationId)?.branch !== undefined);
const { designs: loopDesigns } = useLoopDesigns();
const loopFailure = ref<string>();
const pickedLoop = computed(() => loopDesigns.value.find((design) => design.id === props.conversation.loopId.value));
const endLoop = async (): Promise<void> => {
    // Stops the LOOP, not the turn: whatever iteration is running finishes and lands. Abandoning it outright is
    // this plus the Stop button beside it, which is exactly how it reads on screen.
    await stopLoop(props.conversation.conversationId).catch(() => undefined);
};
// A pick REPLACES a pick, in both directions — see the badge below. The composer can only run the next message
// one way, so holding both ids at once was never a state a person could mean, only one they could reach.
const pickLoop = (design: LoopDesign | undefined): void => {
    runThroughOpen.value = false;
    loopFailure.value = undefined;
    props.conversation.loopId.value = design?.id;
    if (design !== undefined) {
        props.conversation.workflowId.value = undefined;
    }
};
// The picker's way out to the page that owns saved loops AND saved workflows — the same errand the persona
// menu's "Manage" runs, and the only door to the long loop form now that the composer carries none.
const manageRunThrough = (): void => {
    runThroughOpen.value = false;
    void router.push({ name: `extension`, params: { ext: `workflows` }, query: { loop: `list` } });
};

// Claude subscription headroom for this conversation's account, pushed from the agent stream at no token
// cost — a small ring once that account's first Claude turn reports its limits, tinted as the binding pool
// fills. Keyed by account so switching accounts shows the right one. The ring tracks the FULLEST pool (the one
// that will gate the next turn); its card lists them all, because which one is binding shifts between turns.
const usageChip = computed(() => {
    // Resolved through effectiveAccount: a conversation that never picked an account runs on the daemon's
    // first, and the usage map is keyed by that real id — looking up `undefined` kept this chip invisible on
    // every single-account setup.
    const headroom = planHeadroom(usageStatusFor(effectiveAccount(provider.value, account.value)));
    // No binding pool ⇒ nothing measured, or everything has reset. Unlike an account ROW, a chat's chip stays
    // out of the way rather than pinning a 0% to the composer for a session that has not asked for anything.
    if (headroom?.binding === undefined) {
        return undefined;
    }
    // Once a pool is effectively spent the question flips from "how much is left" to "when can I go again", so
    // the binding pool's reset joins the VISIBLE label instead of waiting behind a hover — the chat view is
    // where a limit bites.
    const reset = headroom.percent >= SPENT_PERCENT && headroom.binding.resetsAt !== undefined ? ` · ${formatReset(headroom.binding.resetsAt)}` : ``;
    return { headroom, label: `${formatUtilization(headroom.percent, headroom.stale)}${reset}` };
});

// Per-conversation context-window fill — a ring that warns as the chat approaches auto-compaction.
const contextRing = computed(() => {
    const usage = contextUsage.value;
    if (usage === undefined || usage.contextWindow <= 0) {
        return undefined;
    }
    const pct = Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100));
    return {
        value: pct,
        label: `${pct}%`,
        warn: pct >= 80,
        tooltip: `Context · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${pct}%)`,
    };
});

// True for the assistant turn currently being streamed: the last assistant bubble while streaming. Not
// simply the last message — a steered user message (and trailing notices) land below the bubble the turn
// is still writing into.
const isStreaming = (message: ChatMessage): boolean =>
    streaming.value && message.role === `assistant` && messages.value.findLast((entry) => entry.role === `assistant`)?.id === message.id;

// The transcript as prompt-headed groups. Each group is the box its own prompt is sticky WITHIN (see
// .chat-prompt), which is what ends the pin where the answer ends — rendered flat, every prompt would pin to
// the same top edge and pile up on the one before it. Recomputed per streamed frame like the list it replaces,
// and just as shallow: one pass, no message read beyond its role.
const turns = computed(() => turnsOf(messages.value));

/* THE TRANSCRIPT'S DATE — a day named above the first turn sent on it, and nowhere else (dayMarksOf).
 *
 * A chat is read over days and reopened weeks later, and until now the only place a date appeared at all was
 * inside a per-prompt label nobody sees without hovering the right bubble: "what did I ask on Tuesday" meant
 * hunting with the pointer. One marker per change of day answers it for a whole stretch of turns at once, costs
 * a thin row per day rather than per message, and is what lets each prompt's own stamp shrink to the clock
 * alone (see ChatMessageView's sentClock). */
const dayMarks = computed(() => dayMarksOf(turns.value));

/* WHAT A FORK BELOW EACH TURN INHERITS — the number that turn's mark hands the daemon (forkCutsOf), and the one
 * thing the grouped render has thrown away: a section knows its messages, not where they sit in the flat list.
 *
 * Built as one index rather than searched per turn: `turns` is rebuilt on every paint of a streaming answer, so
 * a findIndex per section would be quadratic in the transcript on every frame — the cost this file's v-memo
 * note is about, arriving by a different road. */
const forkCuts = computed(() => forkCutsOf(turns.value));

// --- Composer --------------------------------------------------------------------------------
const modeLabel = computed(() => modeMeta(mode.value).label);
const modeIcon = computed(() => modeMeta(mode.value).icon);

// Manual textarea auto-grow: reset to one line, then size to content up to the max-height.
const grow = (): void => {
    const el = input.value;
    if (!el) {
        return;
    }
    el.style.height = `auto`;
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
};

// Browser-native voice input: while listening, the running transcript is appended to whatever was already in
// the draft when the mic was toggled on (base), so interim results replace rather than stack.
const { supported: speechSupported, listening, error: speechError, start: startSpeech, stop: stopSpeech } = useSpeechInput();
const toggleSpeech = (): void => {
    if (listening.value) {
        stopSpeech();
        return;
    }
    const base = draft.value;
    startSpeech((transcript) => {
        draft.value = base.length > 0 ? `${base} ${transcript}` : transcript;
        void nextTick(() => {
            grow();
            input.value?.focus();
        });
    });
};

// Web Speech failure codes → a human message. `aborted` (user stopped) and `no-speech` (heard nothing) are
// benign, so they show nothing. `network` is the Brave / de-Googled-Chromium case: those builds ship no Google
// speech key, so the native recognizer can't transcribe — only Chrome/Edge (or a backend STT path) will.
const speechErrorMessage = computed(() => {
    switch (speechError.value) {
        case undefined:
        case `aborted`:
        case `no-speech`:
            return undefined;
        case `not-allowed`:
        case `service-not-allowed`:
            return `Microphone access is blocked. Allow it in your browser's site settings, then try again.`;
        case `audio-capture`:
            return `No microphone was found.`;
        case `network`:
            return `This browser doesn't support voice dictation. Use Chrome or Edge.`;
        default:
            return `Dictation failed (${speechError.value}).`;
    }
});

// --- Attachments ------------------------------------------------------------------------------
// Files staged for the next turn, per-tab like the draft (`attachments` forwards to this pane's conversation).
// ponytail: abandoned drafts orphan their uploads in .intentic/artifacts/attachments (visible/deletable in the
// workspace tree); a daemon-side sweep of stale dirs is the upgrade path if they pile up.

const attach = (file: File): void => {
    const controller = new AbortController();
    // reactive() explicitly: entries are mutated through this reference (progress ticks), not via the
    // array ref's proxy, so the raw object wouldn't trigger updates. The entry lands on the tab active at
    // attach time and this closure keeps pointing at it, so a mid-upload tab switch updates the right chip.
    const entry = reactive<PendingAttachment>({
        id: crypto.randomUUID(),
        name: file.name,
        path: `.intentic/artifacts/attachments/${crypto.randomUUID()}/${file.name}`,
        controller,
        status: `uploading`,
        progress: 0,
        ...(file.type.startsWith(`image/`) ? { previewUrl: URL.createObjectURL(file) } : {}),
    });
    attachments.value = [...attachments.value, entry];
    sandboxUpload(`/workspace/upload?path=${encodeURIComponent(entry.path)}`, file, {
        signal: controller.signal,
        onProgress: (loaded) => {
            entry.progress = file.size > 0 ? loaded / file.size : 1;
        },
    }).then(
        () => {
            entry.status = `done`;
        },
        (err: unknown) => {
            entry.status = `failed`;
            entry.error = errorMessage(err, `Upload failed.`);
        },
    );
};

const removeAttachment = (attachment: PendingAttachment): void => {
    attachment.controller?.abort();
    if (attachment.previewUrl !== undefined) {
        URL.revokeObjectURL(attachment.previewUrl);
    }
    if (attachment.status === `done`) {
        // Fire-and-forget: drop the uploaded uuid dir; on failure the orphan stays visible in the
        // workspace tree, deletable there.
        const dir = attachment.path.slice(0, attachment.path.lastIndexOf(`/`));
        sandboxJson(`/workspace/entry`, jsonBody(`DELETE`, { path: dir })).catch(() => undefined);
    }
    attachments.value = attachments.value.filter((entry) => entry.id !== attachment.id);
};

const onPaste = (event: ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) {
        return;
    }
    event.preventDefault();
    for (const file of files) {
        attach(file);
    }
};

// Depth counter (enter/leave fire per descendant) drives the drop ring on this pane. Per PANE rather than per
// panel: with several open, a dropped screenshot belongs to the chat it was dropped on.
const dragDepth = ref(0);
const onDragEnter = (event: DragEvent): void => {
    if (!connected.value || !event.dataTransfer?.types.includes(`Files`)) {
        return;
    }
    dragDepth.value += 1;
};
const onDragLeave = (): void => {
    dragDepth.value = Math.max(0, dragDepth.value - 1);
};
const onDrop = (event: DragEvent): void => {
    dragDepth.value = 0;
    if (!connected.value || !event.dataTransfer) {
        return;
    }
    // collectDroppedFiles must be called synchronously in the drop handler (drag-store validity window).
    // A dropped folder is walked but attached flat — chat attachments carry no directory structure.
    void collectDroppedFiles(event.dataTransfer).then(({ files }) => {
        for (const dropped of files) {
            attach(dropped.file);
        }
    });
};

// --- Editor context chip ---------------------------------------------------------------------
// What the chip would attach: the live Monaco selection, else the active file tab. OFF by default — the user
// clicks the chip to attach it to the next message (the inverse of VSCode Claude Code's always-on injection).
//
// Gated on the Workspace being the area on screen. The chip's whole claim is "the file you are LOOKING AT",
// and it reads two singletons (useWorkspaceTabs, useEditorSelection) that outlive the Workspace view — while
// this pane is docked in the persistent shell (ShellDesktop) beside whatever area is open. Off /workspace
// there is nothing the user is looking at, so "this file" has no referent and the chip is a stale nag for a
// file they left behind (worse in /agents, where the turn runs in the agent's worktree, not the /work tree
// the tab came from). Route-gated rather than dismissible: it is self-correcting — walk back into the
// Workspace and the chip returns, with nothing to undo.
const route = useRoute();
const workspaceTabs = useWorkspaceTabs();
const editorSelection = useEditorSelection();
const editorTarget = computed<{ file: string; startLine?: number; endLine?: number; selection?: string } | undefined>(() => {
    if (route.name !== `workspace`) {
        return undefined;
    }
    const selection = editorSelection.selection.value;
    if (selection !== undefined) {
        return { file: selection.path, startLine: selection.startLine, endLine: selection.endLine, selection: selection.text };
    }
    const tab = workspaceTabs.activeTab.value;
    return tab?.kind === `file` ? { file: tab.path } : undefined;
});
const includeEditorContext = ref(false);
// Attaching is an explicit per-file choice — a different file in the editor resets the opt-in, as does
// leaving the Workspace (the target goes undefined with the chip, so an opt-in can't outlive the chip that
// explained it and ride along invisibly into a later message).
watch(
    () => editorTarget.value?.file,
    () => {
        includeEditorContext.value = false;
    },
);
const editorChipLabel = computed(() => {
    const target = editorTarget.value;
    if (target === undefined) {
        return ``;
    }
    const name = target.file.split(`/`).pop() ?? target.file;
    return target.startLine !== undefined ? `${name}:${target.startLine}-${target.endLine}` : name;
});
// The composer Send is usable whenever there is something to send — text, a finished attachment, or a queued
// message waiting to go out — regardless of what the conversation is doing: a message written mid-turn is
// never refused, it is delivered into the running turn or queued behind it (see Conversation.enqueue). A
// pending plan is no exception: the typed text becomes revision feedback, and staged files ride along with it
// (Conversation.decidePlan), because a screenshot is the most natural way to say what a plan got wrong.
const staged = computed(() => draft.value.trim().length > 0 || attachments.value.length > 0);
/* WHY SEND IS REFUSING, in the user's words — undefined when the press will land. The only thing that can hold
 * a staged message back is an attachment that isn't on disk yet, and until now that greyed the button out and
 * said nothing: the chip looks finished the moment its thumbnail renders, so a message that will not send has
 * no visible cause anywhere on screen. Anything the composer refuses has to name itself. */
const sendBlock = computed(() => {
    if (!staged.value) {
        // Nothing staged is not a refusal — an empty composer explains itself.
        return undefined;
    }
    if (attachments.value.some((entry) => entry.status === `uploading`)) {
        return `Waiting for the attachment to finish uploading…`;
    }
    if (attachments.value.some((entry) => entry.status === `failed`)) {
        return `An attachment failed to upload — remove it (×) to send.`;
    }
    return undefined;
});
/* THE LAST TURN STOPPED BEFORE IT FINISHED, and this composer is offering to carry it on.
 *
 * The flag itself is the conversation's (Conversation.resumable, which says at length which endings earn it);
 * what the composer adds is the three states in which the offer would be wrong even though the turn really did
 * stop. An EMPTY BOX is the whole of the gesture — the offer is "press this instead of typing", so the moment
 * there are words or files staged, those are what the user means to send. A PENDING PLAN turns the composer
 * into the revision field, where a continuation would be feedback rather than a continuation. And a QUEUED
 * message is already the answer to "what happens next", waiting for a send of its own.
 *
 * One computed for both affordances deliberately: the strip and the Enter key are the same offer wearing two
 * shapes, and a user who reaches for the key because the strip is on screen must not find it does something
 * else. */
const continueOffer = computed(
    () => resumable.value && !staged.value && queued.value.length === 0 && pendingPlanMessage.value === undefined && connected.value,
);
const canSend = computed(() => {
    if (sendBlock.value !== undefined) {
        return false;
    }
    return staged.value || continueOffer.value || (queued.value.length > 0 && !streaming.value && !pendingPlanMessage.value);
});
const sendHint = computed(() => {
    if (sendBlock.value !== undefined) {
        return sendBlock.value;
    }
    if (pendingPlanMessage.value) {
        return `Send as feedback (keep planning)`;
    }
    if (!streaming.value) {
        return `Send`;
    }
    // Mid-turn the message either reaches the running turn or waits for it — say which, so a Send that looks
    // identical in both cases doesn't quietly mean two different things.
    if (awaitingDecision.value) {
        return `Queue for after the request above`;
    }
    return steerable.value ? `Send to the running turn` : `Queue for when this turn ends`;
});
// Stop is offered for every live turn, including one parked on a card — that state is the most common reason to
// want out (a permission the user won't grant, a plan they'd rather restate from scratch), and until now the
// card's own buttons were the only way forward. Name the consequence there: the parked request goes with it.
const stopLabel = computed(() => (awaitingDecision.value ? `Stop the turn` : `Stop generating`));
const stopHint = computed(() =>
    awaitingDecision.value ? `Stop the turn — discards the request above` : mobile.value ? stopLabel.value : `${stopLabel.value} (Esc)`,
);
// While a plan awaits a decision, typing revises it (reject-with-feedback); while a turn runs, typing either
// steers it or queues behind it — the placeholder says which.
// A viewer's composer is present but inert: the transcript is theirs to read, the send is not theirs to make
// (the daemon floors every turn route at collaborator). Disabled-with-a-reason over hidden — an input that
// vanished would read as broken, and the placeholder is where a composer explains itself.
const { canDrive } = useRole();

const composerPlaceholder = computed(() => {
    if (!canDrive.value) {
        return `You're viewing — ask the owner for a collaborator role to drive agents`;
    }
    if (pendingPlanMessage.value) {
        return `Reply to revise the plan…`;
    }
    if (!streaming.value) {
        return `Ask ${providerName.value}…`;
    }
    if (awaitingDecision.value) {
        return `Answer above, or add a message for after…`;
    }
    return steerable.value ? `Steer ${providerName.value} mid-turn…` : `Add a message for when this turn ends…`;
});

// The one line under the queued stack: what will actually happen to those messages. A turn that can take
// mid-turn input has already been offered them (they are only sitting here because it is parked on a card),
// so the wait is the card; an unsteerable turn ends first; with nothing running the queue rides the next send.
const queuedHint = computed(() => {
    if (!streaming.value) {
        return `Sends with your next message`;
    }
    return awaitingDecision.value ? `Sends once you answer the request above` : `Sends when this turn ends`;
});

// The sandbox's message-recall ring (↑ / ↓ / Escape in the composer — see the Message recall section below).
// Resolved per active sandbox rather than held, so switching sandboxes switches rings.
const history = computed(() => (activeSandboxId.value === undefined ? undefined : inputHistoryFor(activeSandboxId.value)));

/* Send the sentence the press stands for (see continueOffer above). It goes down the ordinary send path — it IS
 * an ordinary message, typed by the button instead of by hand — so it lands in the recall ring like any other,
 * and ↑ brings it straight back for anyone who wants to continue with an instruction attached rather than
 * plain. Down here beside the ring rather than up with the offer, so it reads after the thing it writes to. */
const continueTurn = (): void => {
    const text = continuation.value;
    void send(text);
    history.value?.record(text);
    pin();
};

// A tab or sandbox switch swaps the composer's draft out from under a half-finished recall — drop it on both
// the outgoing and incoming ring so ↓/Escape can never paste one tab's draft into another's composer.
watch([() => props.conversation, history], (_current, [, previousHistory]) => {
    previousHistory?.reset();
    history.value?.reset();
});

/* Whether this draft SENDS as a command, which is a different question from what the popover lists: the
 * picker matches the token being typed, this matches the whole first word against the published names. It is
 * the same call the daemon makes on arrival (agent-commands.ts) — a leading `/` runs as a command only when
 * the first token names one, and anything else is prose that goes to the model as written.
 *
 * Only the true case is worth saying. The composer used to speak up for the false one — "No command matches"
 * while the caret sat in the first token — which put a warning over `/workspace` and then withdrew it the
 * moment the user typed a space and the message became the sentence it was always going to be. */
const commandRun = computed<AgentCommand | undefined>(() => {
    const text = draft.value.trimStart();
    if (!text.startsWith(`/`)) {
        return undefined;
    }
    const name = text.slice(1).split(/\s/, 1)[0] ?? ``;
    return availableCommands.value.find((command) => command.name === name);
});

// The one hint slot under the composer. An empty box can't take a newline but CAN take a recall, so it
// advertises whichever of the two is live. Recomputed as the draft empties — which is exactly when a send has
// just filled the ring.
const composerHint = computed(() => {
    // While the agent is generating, the shortcut worth the slot is the way out of it — the same slot is how
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
     * carries the button, and this says the key does the same thing — so the gesture is learned once, at the
     * only moment it applies, and costs the composer nothing on every other turn. Ahead of the recall hint
     * because it is the rarer state and the more useful one: ↑ is always there, and this is not. */
    if (continueOffer.value) {
        return `Enter to continue`;
    }
    return draft.value === `` && history.value?.recallable === true ? `↑ for previous message` : `Shift+Enter for new line`;
});

// The staged chips as the message carries them: upload metadata plus the object URL, so the bubble it lands on
// shows the same thumbnail the chip did without re-reading the bytes.
const snapshotAttachments = (): ChatAttachment[] =>
    attachments.value.map(({ name, path, previewUrl }): ChatAttachment => ({ name, path, ...(previewUrl !== undefined ? { previewUrl } : {}) }));

/* --- The workflow this composer is aimed at ------------------------------------------------------
 * A pick, held on the conversation (Conversation.workflowId) beside the model and the effort, because that is
 * what it is: one more answer to "what happens when I press send". Set it and the next message is not a turn
 * on this chat at all — it is the REQUEST of a run, handed to every step of a saved design.
 *
 * IT IS A BADGE AND NOT A ONE-SHOT PICKER, which is the correction. It used to be a pill that opened a list
 * and started a run the moment you chose from it, so the choice and the send were the same press and there
 * was nothing on screen, before or after, saying which design your words had gone to. Now the badge names the
 * pick and stays named until the message goes.
 *
 * The pick CLEARS on a successful send. A workflow fans one message into several paid sessions, and a badge
 * that survived its own run would make the next message do it again silently.
 */
const { start: startWorkflow, designs: workflowDesigns } = useWorkflowRuns();
const workflowFailure = ref<string>();
const pickedWorkflow = computed(() => workflowDesigns.value.find((workflow) => workflow.id === props.conversation.workflowId.value));

/* Close the model and mode panels whenever the pill they hang off stops being usable, which happens two ways.
 * The pills live behind `v-if="connected"`, so switching to a disconnected provider unmounts the anchor out
 * from under an open panel; and a picked workflow greys them, which a panel already open would happily go on
 * ignoring — a tab switch is enough to land in that state, since the open flags belong to the pane and the
 * badge belongs to the conversation. Either way the answer is the same: the composer that owns them closes
 * them.
 *
 * The run-through panel is NOT in this list, and that is the point of it: it is the one control a picked
 * workflow leaves live, because it is the control holding the pick. Closing it on `!isConnected` would be
 * right, but the pick that lands there closes it already, and unpicking has to stay reachable.
 */
watch([connected, pickedWorkflow], ([isConnected, workflow]) => {
    if (!isConnected || workflow !== undefined) {
        modelOpen.value = false;
        modeOpen.value = false;
        personaOpen.value = false;
    }
});

// The loop pick's mirror image: one badge, one answer, so arming this disarms that.
const pickWorkflow = (workflow: Workflow | undefined): void => {
    runThroughOpen.value = false;
    workflowFailure.value = undefined;
    props.conversation.workflowId.value = workflow?.id;
    if (workflow !== undefined) {
        props.conversation.loopId.value = undefined;
    }
};

/* --- THE RUN-THROUGH BADGE ------------------------------------------------------------------------
 * ONE control for the one question — what is the next message run THROUGH — and it took two pills far too
 * long to admit they were asking it. A loop repeats the message here until a bar is cleared; a workflow hands
 * it to a design of sessions that are not this one. Different machines, mutually exclusive answers, and the
 * old row expressed that exclusivity by greying whichever pill you hadn't used yet.
 *
 * FOUR STATES, in this precedence:
 *
 *  - RUNNING a loop — the round count, and the press ENDS it. Outranks everything, including a workflow the
 *    user might otherwise want to arm mid-loop: a loop already going spends money with nobody pressing
 *    anything between rounds, so the one press it needs is the way out, and a badge that hid the stop behind
 *    a menu would leave the fleet board as the only exit. One press ends it and the badge is a picker again.
 *  - WORKFLOW armed — the design's own glyph and name, in the active tint.
 *  - LOOP armed — the same, in the loop's glyph.
 *  - Nothing — a bare `fork`: a message taking some route other than straight down into this chat. Neither of
 *    the two specific glyphs, deliberately, since either would read as one of them already being armed.
 *
 * Never greyed under a workflow badge the way model, effort, mode and persona are. Those describe a turn the
 * workflow send doesn't make; this one IS the badge, and a control you cannot press to undo is a trap.
 */
const runThroughIcon = computed<IconName>(() => {
    if (looping.value || pickedLoop.value !== undefined) {
        return `repeat`;
    }
    return pickedWorkflow.value === undefined ? `fork` : `sitemap`;
});
const runThroughName = computed(() => pickedWorkflow.value?.name ?? pickedLoop.value?.name);
const runThroughHint = computed(() => {
    if (looping.value) {
        return `Stop looping — iteration ${activeLoop.value?.iteration} finishes first. Use Stop to cut it short.`;
    }
    if (pickedWorkflow.value !== undefined) {
        return `Send runs “${pickedWorkflow.value.name}” with this message as its request`;
    }
    if (pickedLoop.value !== undefined) {
        return `Send runs “${pickedLoop.value.name}” — this message is the goal, repeated until it is met`;
    }
    return `Repeat this message until a goal is met, or run it through a workflow`;
});
const runThroughLabel = computed(() => {
    if (looping.value) {
        return `Stop looping`;
    }
    if (pickedWorkflow.value !== undefined) {
        return `Workflow: ${pickedWorkflow.value.name}`;
    }
    return pickedLoop.value === undefined ? `Run this message through a loop or a workflow` : `Loop: ${pickedLoop.value.name}`;
});

/* WHO THIS CHAT IS WHEN IT REACHES THE OUTSIDE WORLD. The pick lives on the conversation (and rides every turn
 * it sends); what the pane adds is the card behind the id — the name on the pill, and the one state worth
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
        return `This chat acts as “${pinned}”, which no longer exists — it would reach no account and no tools. Pick another persona.`;
    }
    if (pickedPersona.value.capabilities.length === 0) {
        return `${personaName.value} holds no accounts, so this chat can work but can't post, reply or send as anyone.`;
    }
    return pickedPersona.value.capabilities.some((held) => personaSignedIn(held))
        ? undefined
        : `${personaName.value} isn't signed in yet, so this chat can't act as it. Finish its login under Capabilities.`;
});

const pickPersona = (id: string | undefined): void => {
    personaOpen.value = false;
    props.conversation.actsAs.value = id;
    /* A CARD THAT SAYS WHERE IT WORKS MOVES THE CHAT THERE — but only before the chat has started, which is
     * exactly the moment the daemon reads the same field (it decides placement on a conversation's FIRST turn
     * and follows its own registry entry after that). Mirrored here so the two agree from the pick onwards:
     * `isolated` is not display-only on this side — the tab's name, a fork's "files as they were", and every
     * diff link in the transcript are drawn from it, so a chat working in its own copy while this said
     * otherwise would point them all at the wrong tree. */
    const copy = personaCards.value.find((persona) => persona.id === id)?.workspace?.copy;
    if (copy !== undefined && !props.conversation.registered.value) {
        props.conversation.isolated.value = copy === `own`;
    }
};

/* Send the draft as a run's request. The draft is cleared on success for the reason an ordinary send clears it
 * — the text has gone somewhere — and KEPT on failure, because the message is all the user has and a control
 * that eats it is one nobody presses twice. Then the run takes the screen (openRunInChat), which is the same
 * landing the board's card gives it.
 */
const sendThroughWorkflow = async (workflow: Workflow): Promise<void> => {
    workflowFailure.value = undefined;
    const request = draft.value.trim();
    try {
        const run = await startWorkflow.mutateAsync({ id: workflow.id, ...(request === `` ? {} : { request }) });
        draft.value = ``;
        props.conversation.workflowId.value = undefined;
        await openRunInChat(run);
    } catch (error) {
        workflowFailure.value = error instanceof Error ? error.message : `The workflow could not be started.`;
    }
};

/* Start the armed loop with the draft as its goal. The draft clears on success for the reason an ordinary send
 * clears it — the words have gone somewhere — and is KEPT on failure, because the message is all the user has.
 *
 * The badge clears too, and that is the one thing here that must not be forgotten: a loop spends money per
 * round with nobody pressing anything in between, so a badge that survived its own start would turn the next
 * ordinary message into a second paid loop, silently.
 */
const sendThroughLoop = async (design: LoopDesign): Promise<void> => {
    loopFailure.value = undefined;
    const goal = draft.value.trim();
    try {
        await startLoop(loopFromDesign(design, { conversationId: props.conversation.conversationId, goal, isolated: loopIsolated.value }));
        draft.value = ``;
        props.conversation.loopId.value = undefined;
    } catch (error) {
        loopFailure.value = error instanceof Error ? error.message : `The loop could not be started.`;
    }
};

const submit = (): void => {
    workflowFailure.value = undefined;
    loopFailure.value = undefined;
    /* THE BADGE INTERCEPTS THE SEND, ahead of every gate below it — those are about a TURN on this
     * conversation (a pending plan, a running turn to steer, staged attachments), and this message is not one.
     * It goes to a graph of sessions that are not this chat, so none of the machinery for putting words into
     * this chat applies. `connected` still does: with no daemon there is nothing to start. */
    const workflow = pickedWorkflow.value;
    if (workflow !== undefined && connected.value) {
        void sendThroughWorkflow(workflow);
        return;
    }
    /* The loop badge intercepts next, and BELOW the workflow one because a workflow greys the loop pill: the
     * two can never be armed at once, so the order is a formality kept explicit rather than a precedence.
     *
     * Unlike a workflow's, this send does need a goal — a loop with an empty one has nothing to converge on and
     * the daemon's own schema refuses it — so it gates on `staged`, the composer actually holding something,
     * rather than on `canSend`. The two are not the same question: `canSend` is also true for the presses that
     * send something OTHER than the draft (a queue to flush, a stopped turn to continue), and a loop started off
     * one of those would go up with no goal at all. It is not a turn on this chat either, so nothing below it
     * applies: a loop drives its own. */
    const loop = pickedLoop.value;
    if (loop !== undefined && connected.value && staged.value && !looping.value) {
        void sendThroughLoop(loop);
        return;
    }
    // canSend covers the gates that are left: an empty composer and an attachment that isn't on disk yet.
    if (!connected.value || !canSend.value) {
        return;
    }
    /* NOTHING TYPED AND A TURN LEFT HANGING: the press means Continue (see continueOffer). Below the badges,
     * which are explicit choices the user armed, and above everything else, because every gate under here reads
     * the draft — and the whole point of this branch is that there isn't one. */
    if (continueOffer.value) {
        continueTurn();
        return;
    }
    const text = draft.value.trim();
    const pendingPlan = pendingPlanMessage.value;
    if (pendingPlan) {
        // Typing while a plan is pending rejects it with that text as feedback (Claude Code style) — the
        // agent stays in plan mode and revises. Staged files go with it (as workspace paths in the feedback —
        // see decidePlan), then clear like a normal send: WITHOUT revoking the preview URLs, which the user
        // bubble the rejection leaves behind now owns.
        void decidePlan(pendingPlan, false, text, snapshotAttachments());
        attachments.value = [];
    } else {
        const target = editorTarget.value;
        const editorContext =
            includeEditorContext.value && target !== undefined
                ? {
                      file: target.file,
                      ...(target.selection !== undefined
                          ? { startLine: target.startLine, endLine: target.endLine, selection: target.selection.slice(0, 20_000) }
                          : {}),
                  }
                : undefined;
        // One path whether or not a turn is running — the conversation delivers it into the running turn or
        // queues it (see Conversation.enqueue). Snapshot the chips onto the message, then clear WITHOUT
        // revoking preview URLs — the thumbnails now live on the queued/sent message.
        void send(text, snapshotAttachments(), editorContext);
        attachments.value = [];
        includeEditorContext.value = false;
    }
    // Both branches send `text` somewhere (a turn, the queue, a plan revision), so both earn a slot in the
    // recall ring — except the bare "flush the queue" press, which contributed no text of its own.
    if (text.length > 0) {
        history.value?.record(text);
    }
    // Sending is a statement that the bottom is where the user now wants to be — they wrote the newest thing
    // in the transcript. It re-arms the follow they gave up by scrolling away to check something before
    // writing, which is the one case where the "leave the reader alone" rule would be reading the wrong intent.
    pin();
    draft.value = ``;
    // Snap the box back to one line and keep the cursor ready for the next message.
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
};

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
    // Typing makes the text the user's own again — a recalled message they have started editing is a draft, so
    // the stashed one it displaced is no longer anyone's to restore. Only real keystrokes land here: the
    // programmatic draft writes (recall, mention/command picks) go through v-model and fire no input event.
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
// saying so — see ChatCommandPopover's header for why that line was the wrong warning.
const commandMatches = computed<readonly AgentCommand[]>(() => {
    const needle = slashQuery.value?.toLowerCase();
    return needle === undefined ? [] : availableCommands.value.filter((command) => command.name.toLowerCase().includes(needle));
});
const mentionPopover = ref<InstanceType<typeof ChatMentionPopover>>();
const commandPopover = ref<InstanceType<typeof ChatCommandPopover>>();
const mentionOpen = computed(() => activeMention.value !== undefined && !popoverDismissed.value);
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
    // A recalled message is complete — a leading `/` or an @-path in it must not pop an autocomplete list open
    // over it. Dismissed on the next tick, after the query watch above has re-armed on the new draft.
    void nextTick(() => {
        popoverDismissed.value = true;
    });
};

// Returns true when recall consumed the key — see recallStep for which presses it claims and which walk the
// caret to the edge of a wrapped line first. Nothing is claimed while text is selected: there the arrows are
// collapsing a selection, not navigating. The live element is read rather than the `caret` ref, which only
// tracks keyup/click and so goes stale under an auto-repeating arrow — exactly the case that decides when the
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
    // The step always lands on an edge of the draft, which past max-h-48 is scrolled out of view — and moving a
    // textarea's selection does not reliably bring it back. Without this the caret would leave the visible rows
    // and the press would read as having done nothing.
    el.scrollTop = step.at === 0 ? 0 : el.scrollHeight;
    return true;
};

const onKeydown = (event: KeyboardEvent): void => {
    // Never submit mid-IME-composition (CJK candidates confirm with Enter).
    if (event.isComposing) {
        return;
    }
    // An open popover owns the list keys; Enter/Tab pick, Escape dismisses, arrows move.
    const popover = mentionOpen.value ? mentionPopover.value : commandOpen.value ? commandPopover.value : undefined;
    if (popover !== undefined) {
        if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
            event.preventDefault();
            popover.move(event.key === `ArrowDown` ? 1 : -1);
            return;
        }
        if (event.key === `Escape`) {
            event.preventDefault();
            popoverDismissed.value = true;
            return;
        }
        if ((event.key === `Enter` && !event.shiftKey) || event.key === `Tab`) {
            if (popover.pickActive()) {
                event.preventDefault();
                return;
            }
        }
    }
    // After the popovers: an open @/-list owns the arrows for the token being typed, and recall's own Escape
    // must not pre-empt dismissing that list.
    if (recallKeydown(event)) {
        return;
    }
    // Escape interrupts the turn (Claude Code's shortcut), once the popovers and message recall have had their
    // claim on the key. Only while it's GENERATING: a turn parked on a card is spending nothing, and losing a
    // plan the user is still reading to a stray Escape costs far more than the keystroke saves — the Stop
    // button is the deliberate way out of that one.
    if (event.key === `Escape` && streaming.value && !awaitingDecision.value) {
        event.preventDefault();
        stop();
        return;
    }
    if (event.key !== `Enter`) {
        return;
    }
    // On mobile Enter is a newline (the send button submits) — the virtual keyboard has no Shift+Enter.
    if (mobile.value) {
        return;
    }
    // Enter (or Cmd/Ctrl+Enter) sends; Shift+Enter inserts a newline.
    if (!event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        submit();
    }
};

// --- Tabs / history --------------------------------------------------------------------------
// This pane's half of "New agent" (and of anything else that hands the user the composer): the action itself
// lives in agentActions.startAgent, which opens the tab wherever it was pressed — the board, the strip's "+",
// the mobile header — and then asks for the caret. A composer is the only thing that can give it, so the pane
// answers the signal, and every surface gets the same result instead of the one that happens to sit next to
// the textarea getting a better one. Only the FOCUSED pane answers: the signal names no conversation, and the
// tab it was raised for is the one that just took the focus. The scroller needs nothing here — a new tab is a
// new conversation, and the watch below pins on that.
watch(composerFocus, () => {
    if (!props.focused) {
        return;
    }
    void nextTick(() => {
        grow();
        input.value?.focus();
    });
});

// --- Lifecycle / effects ---------------------------------------------------------------------
/* Make the native scrollbar truthful after a transcript lands wholesale.
 *
 * .chat-message rows are content-visibility:auto with a 3rem estimate (chat.css), so a freshly swapped-in
 * transcript reports a scrollHeight built almost entirely of estimates. Left alone, every row realizing on
 * the way past rewrites scrollHeight mid-scroll — and a native scrollbar DRAG maps the thumb against the
 * current scrollHeight, so the thumb kept leaping hundreds of px away from the cursor. The cure is one
 * idle-time realization pass: .chat-realize forces every row to lay out for real, `auto` records those
 * heights as remembered sizes, and skipping resumes with a scrollHeight that no longer moves.
 *
 * Two frames under the class on purpose: the first lays the realized transcript out and records remembered
 * sizes (that happens at resize-observer timing, at the end of the frame), the second may drop back to
 * skipping. A followed transcript survives the growth spurt through useStickToBottom's own observer;
 * elsewhere scroll anchoring holds the view. requestIdleCallback keeps the one full layout off the restore's
 * critical path (Safari has no idle callback — a beat of setTimeout is the same bargain). */
const realizing = ref(false);
let warmQueued = false;
// Both callbacks are the TRANSCRIPT's window's — asked for afresh at each step, since a pop-out or a dock can
// land between them. Asking the opener (where this code runs) is asking a window that is typically behind the
// chat window and getting no rendering steps at all: the pass never ran, and the latch below never lifted.
const whenIdle = (task: () => void): void => {
    const view = transcriptWindow();
    if (view === undefined) {
        // Nothing left to schedule against. The work is a scroll warm-up, so dropping it costs a frame of
        // layout on a pane that no longer exists.
        return;
    }
    if (view.requestIdleCallback === undefined) {
        view.setTimeout(task, 200);
        return;
    }
    view.requestIdleCallback(task);
};
const warmTranscript = (): void => {
    if (warmQueued) {
        return;
    }
    warmQueued = true;
    whenIdle(() => {
        realizing.value = true;
        void nextTick(() => {
            const view = transcriptWindow();
            if (view === undefined) {
                // The document went away between the idle callback and this tick. Clear the latch by hand,
                // since the frames that would have cleared it are never going to run.
                realizing.value = false;
                warmQueued = false;
                return;
            }
            view.requestAnimationFrame(() =>
                view.requestAnimationFrame(() => {
                    realizing.value = false;
                    warmQueued = false;
                }),
            );
        });
    });
};

// Every path that mounts never-painted rows outside the viewport, and nothing that fires per streamed frame:
// a tab switch or history open swaps the whole list (conversationId), the IndexedDB repaint and the daemon's
// replay land in bulk (length jumps while idle — a live turn only ever appends one bubble per flush), and a
// turn's end covers an answer that streamed in below the fold while the user was scrolled up reading.
watch(() => props.conversation.conversationId, warmTranscript, { immediate: true });
watch(
    () => messages.value.length,
    (now, before) => {
        if (!streaming.value && Math.abs(now - before) > 1) {
            warmTranscript();
        }
    },
);
// A pop-out or a dock is a new window at a new width, so every row's remembered size is a measurement of
// somewhere else — and a pass left in flight is owed frames by the window just left, which will never deliver
// them. Clearing the latch is what stops that one missed hand-off from disabling warming for the session.
watch(
    poppedOut,
    () => {
        warmQueued = false;
        realizing.value = false;
        warmTranscript();
    },
    { flush: `post` },
);
watch(streaming, (now, was) => {
    if (was && !now) {
        warmTranscript();
    }
});

/* A different transcript is on screen — start it at its newest message, the way a chat is opened everywhere.
 *
 * This is the ONE place that says so, and it is the state itself rather than any of the presses that reach it:
 * the strip's tabs and history menu, the agents board opening a card, /agents/:id, the review panel, a closed
 * tab handing focus to its neighbour. Half of those don't know this pane exists — which is exactly how the
 * bug this replaces worked, since each of them had to remember to re-pin and only three did. Post-flush so the
 * new transcript is in the DOM to be scrolled; what arrives later (a hydrate, the cached repaint, an attached
 * live turn) grows the transcript, and the pin follows growth on its own.
 *
 * A tab switch also swaps a possibly multi-line draft under the textarea — re-size the box to the new one. */
watch(
    () => props.conversation.conversationId,
    () => {
        pin();
        grow();
    },
    { flush: `post` },
);

/* The transcript changed — follow it, if the reader has not scrolled up.
 *
 * The composable's observers say "these boxes are a different size now", which is a measurement, taken in a
 * frame, and delivered in one: a notification the browser coalesces or defers past the layout that produced it
 * (a resize-observer loop that hits its depth limit does precisely this, and a transcript of
 * content-visibility rows realizing under a scroll write is how you get there) leaves the newest content below
 * the fold with nothing to bring it up. That was this bug: the message went out, "Perusing…" was appended
 * under the composer, and the panel sat exactly where it was.
 *
 * So the pane states the fact it holds directly, in terms no frame can lose: a message arrived or left, and a
 * turn started or ended — which is the loader, the one thing a send puts on screen before the answer exists.
 * O(1) per flush and post-flush, so the row is in the DOM to be scrolled to; a streamed frame appends text to
 * a bubble that is already counted, and stays the observers' job. */
watch([() => messages.value.length, streaming], follow, { flush: `post` });

// Drop focus into the composer as soon as the account connects; grow sizes the box to a restored draft (the
// textarea mounts with the persisted text already in it). Not on mobile — autofocus there pops the keyboard
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
         the width left for the transcript rather than off the panel plus its rail — and with several panes
         open, off THIS pane's share of it. -->
    <div
        class="chat-pane @container relative flex min-h-0 min-w-0 flex-1 flex-col"
        :class="{ 'chat-pane-on': focused }"
        @pointerdown="takeFocus"
        @focusin="takeFocus"
        @dragenter="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent.stop="onDrop"
    >
        <div
            v-if="dragDepth > 0"
            class="pointer-events-none absolute inset-1 z-30 rounded-xl border-2 border-dashed border-primary-500 bg-primary-500/10"
        ></div>
        <!-- GIVING THIS COLUMN BACK. It floats over the transcript's top-right corner rather than sitting in a
             header, because a pane has no header — a bar per column would cost every pane a strip of height to
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
             chips, the queued stack, a banner) and no more. Scrolled up, the messages pass under it — see
             the composer's own note.
             The inner wrapper is what the autoscroll ResizeObserver measures; the scroller itself never
             changes height, so it can't report either of them growing.
             The insets live in here rather than on the scroller: a sticky element resolves against the
             scroller's PADDING edge, so padding out there would leave a band above the pinned prompt (and
             below the composer) for the transcript to slide through. It also lets the composer be wider
             than the column of text, which a padding shared by both could not. -->
        <!-- .chat-scroller is the IntersectionObserver root each prompt uses to tell whether it is pinned. -->
        <div ref="scroller" class="chat-scroller scrollbar-thin flex flex-1 flex-col overflow-auto" :class="{ 'chat-realize': realizing }">
            <div ref="content" class="flex min-w-0 flex-1 flex-col">
                <div class="chat-turns flex flex-1 flex-col gap-1 pt-4">
                    <!-- Where a forked chat says so — above the turns it inherited, which without it read as
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
                            <!-- THE DAY THIS STRETCH OF THE CONVERSATION WAS SENT ON — drawn only where the date
                                 changes (dayMarks), so a chat written in one sitting carries exactly one and a
                                 chat picked up over a fortnight says so where it was picked up. Between the
                                 sections rather than inside one, because it is a boundary, not part of a turn.
                                 Bare centred text, no rule across the column: a line there fences the turns off
                                 from each other, which is the reason the old cut line between every two turns
                                 went (see ChatForkCut). Weighted above rather than below — the marker belongs to
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
                            <section class="group/turn relative flex flex-col gap-1">
                                <!-- v-memo skips the vnode entirely for a row whose inputs are unchanged, which
                                     during a streaming turn is every row but the one being written: `turns` is
                                     rebuilt on each paint, so without it the whole transcript is re-created to
                                     redraw one bubble. The key lists exactly what the row renders from — a
                                     message keeps its identity through the reducer unless that message changed,
                                     and `folded` holds still per turn (see ChatTurn.folded). -->
                                <ChatMessageView
                                    v-for="message in turn.messages"
                                    :key="message.id"
                                    v-memo="[message, isStreaming(message), turn.folded]"
                                    :message="message"
                                    :streaming="isStreaming(message)"
                                    :folded="message.id === turn.id ? turn.folded : undefined"
                                />
                                <!-- THE FORK POINT of this turn, in the column's MARGIN at the end of the answer:
                                     everything down to here is what a fork keeps, and everything after it is
                                     what it leaves behind. Last in the section so it stands level with the close
                                     of what was said rather than in the middle of it, and drawn inside the
                                     section so it hangs off the turn's own hover — a mark nobody is pointing at
                                     is invisible. It costs the transcript no height (see ChatForkCut). -->
                                <ChatForkCut :cut="forkCuts.get(turn.id) ?? messages.length" />
                            </section>
                        </template>
                    </template>
                    <!-- The transcript is on its way (a history open, a restored tab whose local mirror was
                         empty). Without this state the round-trip wears the "Start a conversation" text
                         below, which over a chat that merely hasn't arrived yet reads as data loss. -->
                    <ChatTranscriptSkeleton v-else-if="activeLoading" />
                    <p v-else class="m-auto max-w-[80%] text-center text-xs text-muted">Start a conversation with {{ providerName }}.</p>
                    <p v-if="activeError" class="text-xs text-danger">{{ activeError }}</p>
                </div>

                <!-- The composer and the notices that gate it. All of it talks to the daemon, so it yields to a
                     hint while the sandbox is unreachable; the transcript above stays readable.
                     It is the LAST ROW OF THE TRANSCRIPT, stuck to the bottom edge, rather than a band beneath
                     it. In its own row it was panel background wrapped around the box, and that padding read as
                     chrome the composer was mounted on — which is what a chat's most-used control should least
                     look like. Here the only surface is the composer's own rounded box (and whichever banners
                     are up): the transcript runs to the bottom of the pane and, once the user scrolls up,
                     slides under a box with nothing but transparent padding around it. Parked at the bottom
                     there is nothing behind it to see, because being in the flow is what reserves its room.
                     .chat-footer hands pointer events in that transparent region back to the messages, and the
                     z-index clears .chat-prompt's — a pinned prompt is opaque, and in a pane short enough
                     (mobile with the keyboard up) it reaches this far down.
                     The box is a touch WIDER than the column of text it sits under (50rem against .chat-turns'
                     48rem, and a half-inset against its full one below either cap): a composer flush with the
                     prose reads as one more block of the transcript, and the reading measure is a rule for text,
                     not one the app's controls have to line up on. Capped at all for the popped-out window,
                     where a full-width composer is a 150-character line with its Send button half a screen from
                     the text. -->
                <div class="chat-footer sticky bottom-0 z-10 mx-auto flex w-full max-w-[51rem] flex-col gap-2 px-2 py-3">
                    <p v-if="!reachable" class="px-1 text-2xs text-subtle">
                        {{
                            denied
                                ? `Chat is unavailable — this Google account has no access to this sandbox.`
                                : `Chat is available once your sandbox is connected.`
                        }}
                    </p>
                    <template v-else>
                        <!-- This conversation's agent is off the board. Muted, not a warning: archiving loses nothing
                         (the branch, the diff, the transcript and every counter stay — this tab is the proof), so
                         the line states a fact rather than raising an alarm. It carries the one thing no other
                         surface could tell the user in time — that sending from here un-archives the agent — and
                         the press that does it deliberately, without sending anything. -->
                        <div
                            v-if="activeArchived !== undefined"
                            class="flex items-center gap-2 rounded-xl border border-line bg-overlay/60 px-3 py-2 text-2xs text-muted"
                        >
                            <Icon name="box" class="shrink-0" />
                            <span class="min-w-0 flex-1">Archived — off the agents board. Sending a message puts it back.</span>
                            <button
                                type="button"
                                class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
                                :disabled="busyIds.includes(activeArchived.id)"
                                v-tooltip.top="'Put this agent back on the board now'"
                                @click="restore([activeArchived.id])"
                            >
                                Restore
                            </button>
                        </div>
                        <ChatAccountPanel />
                        <!-- THE TRIAL'S STANDING DISCLOSURE. The picker says it once, at the moment of choosing;
                             this says it for as long as the choice is in force, because the person typing may not
                             be the person who picked, and a conversation can outlive the click that started it.
                             Exhausted, the same strip becomes the signpost to the free Google sign-in — the next
                             rung, and the one with no daily cap. -->
                        <button
                            v-if="trialNotice"
                            type="button"
                            class="flex items-start gap-2 rounded-xl border border-line bg-overlay/40 px-3 py-2 text-left text-2xs text-muted"
                            @click="router.push({ path: '/sandbox/agent', query: { connect: 'gemini' } })"
                        >
                            <Icon name="sparkles" class="mt-0.5 shrink-0 text-link" />
                            <span>{{ trialNotice }}</span>
                        </button>
                        <!-- Proactive re-auth prompt: the account is connected (a credential exists) but can no longer be
                         refreshed, so surface it here — before a send fails opaquely — with a jump to reconnect. -->
                        <button
                            v-if="activeAccountReauth"
                            type="button"
                            class="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
                            @click="router.push({ path: '/sandbox/agent', query: { connect: provider } })"
                        >
                            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
                            <span
                                >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }}
                                <span class="font-semibold underline">Reconnect</span></span
                            >
                        </button>
                        <!-- Provider-outage banner: the turn is coming back on an escalating backoff, and this
                         says when and how many tries are left. Naming the bound is the point — an automation
                         spending the user's allowance while they watch has to account for itself, or the
                         reasonable response is to switch it back off. -->
                        <div
                            v-if="outageResume"
                            class="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-overlay/60 px-3 py-2 text-2xs text-muted"
                        >
                            <Icon name="clock" class="mt-0.5 shrink-0" />
                            <span v-if="outageResume.scheduled" class="min-w-0 flex-1"
                                >The model provider failed this turn — retrying by itself in {{ formatWait(outageResume.retryAt) }} (attempt
                                {{ outageResume.attempt }} of {{ outageResume.maxAttempts }}). Sending again yourself works too.</span
                            >
                            <!-- The button turns on a SANDBOX-WIDE setting, not just this chat's, which is the
                                 one thing about it worth saying — so it is said in the sentence the card is
                                 already made of rather than in a box only a pointer can open. -->
                            <span v-else class="min-w-0 flex-1"
                                >The model provider failed this turn. Auto-resume is off — turn it on (a standing setting for the whole sandbox) and
                                this chat continues from here by itself.</span
                            >
                            <button
                                v-if="!outageResume.scheduled"
                                type="button"
                                class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
                                :disabled="sandboxSettings === undefined || saveSandboxSettings.isPending.value"
                                @click="enableOutageResume"
                            >
                                Enable auto-resume
                            </button>
                        </div>
                        <!-- THE TURN STOPPED BEFORE IT FINISHED, and here is the way on. Under the outage
                             banner and above the queue, because that is the order the three answer "what is
                             happening to my work": one is coming back by itself, this one is waiting on a
                             press, and the queue is what goes next either way. The two can't both be up —
                             an outage arms its own resume and never this one.
                             The key is named on the button rather than in a tooltip. A pointer that has
                             travelled to the button has already spent what the shortcut would have saved,
                             so the only reader it can still help is the one who hasn't moved yet — and the
                             composer's hint slot says the same thing one line below, for exactly them. -->
                        <div
                            v-if="continueOffer"
                            class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-overlay/60 px-3 py-2 text-2xs text-muted"
                        >
                            <Icon name="pause" class="shrink-0" />
                            <span class="min-w-0 flex-1">This turn stopped before it finished — the work so far is still here.</span>
                            <button
                                type="button"
                                class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
                                v-tooltip.top="'Pick up where it left off, without retyping'"
                                @click="continueTurn"
                            >
                                Continue<span v-if="!mobile" class="font-normal text-subtle"> · Enter</span>
                            </button>
                        </div>
                        <template v-if="connected">
                            <!-- Messages written while the agent was busy that haven't reached it yet. They sit here
                             rather than in the transcript because they are not part of the conversation until the
                             agent has them — a steered one moves into the transcript the moment the daemon takes
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
                                        v-tooltip.top="'Remove — this message will not be sent'"
                                        aria-label="Remove queued message"
                                    >
                                        <Icon name="times" class="text-2xs" />
                                    </button>
                                </div>
                                <p class="px-1 text-2xs text-subtle">{{ queuedHint }}</p>
                            </div>
                            <form
                                class="relative flex flex-col rounded-2xl border border-line-strong bg-overlay shadow-lg transition-colors focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/25"
                                @submit.prevent="submit"
                            >
                                <ChatMentionPopover v-if="mentionOpen" ref="mentionPopover" :query="activeMention?.query ?? ''" @pick="pickMention" />
                                <ChatCommandPopover v-if="commandOpen" ref="commandPopover" :commands="commandMatches" @pick="pickCommand" />
                                <div v-if="attachments.length > 0 || editorTarget !== undefined" class="flex flex-wrap gap-2 px-3 pt-3">
                                    <!-- Editor-context chip: off by default, one click attaches the open file /
                                     selection to the next message — the inverse of VSCode Claude Code. Sized
                                     like the attachment chips beside it. -->
                                    <button
                                        v-if="editorTarget !== undefined"
                                        type="button"
                                        class="flex items-center gap-1.5 rounded-lg border py-1.5 px-2 text-xs transition-colors"
                                        :class="
                                            includeEditorContext
                                                ? 'border-primary-500 bg-primary-500/10 text-content'
                                                : 'border-dashed border-line text-subtle hover:text-content'
                                        "
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
                                        <ChatImageThumb v-if="a.previewUrl" :src="a.previewUrl" :alt="a.name" size="h-9 w-9" />
                                        <Icon name="file" v-else class="text-sm text-subtle" />
                                        <span class="max-w-36 truncate text-content" v-tooltip.top="a.error ?? a.name">{{ a.name }}</span>
                                        <!-- The chip's own state, in a glyph. The progress hairline below is
                                             invisible once it fills, so a chip whose bytes are still in flight
                                             read as finished — while Send stayed disabled behind it. -->
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
                                            @click="removeAttachment(a)"
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
                                    class="scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-base leading-relaxed text-content placeholder:text-subtle focus:outline-none md:text-xs"
                                    @input="onInput"
                                    @keydown="onKeydown"
                                    @keyup="syncCaret"
                                    @click="syncCaret"
                                    @paste="onPaste"
                                ></textarea>

                                <div class="flex items-center gap-1 px-2.5 pb-2.5">
                                    <!-- MODEL, EFFORT, MODE, PERSONA GO INERT UNDER A WORKFLOW BADGE, and that is not
                                         a caveat about the feature — it is what the badge means. Every one of them
                                         describes a turn on THIS conversation, and a workflow send makes none: the
                                         message becomes a run's request, and each step opens its own unattended
                                         session on the provider, harness and model the step declares, looping the way
                                         the step says to loop. Left live they were four controls that changed nothing
                                         about the press beneath them — pick Opus · Max · Plan, watch the run come back
                                         on something else, and you would be right to call it a bug.

                                         The run-through badge at the end of the row is the exception, because it is
                                         the badge: see it for why it never dims.

                                         Dimmed rather than hidden: they still say what an ordinary send would use, the
                                         line under the box says whose they are instead, and the badge is one press
                                         from handing them back — a control that vanished would take that offer with
                                         it. -->
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
                                        label-class="@max-sm:hidden"
                                    />

                                    <!-- MODE leads the right-hand group, and the group reads left to right as a
                                         gradient away from the model: which brain (model · effort), then how it
                                         works (mode), then who it is (persona), then what the message is run
                                         through (loop or workflow). Mode sits closest to effort because the two
                                         are one thought — how hard it thinks, and how much rope it has — and
                                         because it is the only pill here that is always worded, so it anchors
                                         the row's baseline where a bare glyph could not. -->
                                    <button
                                        ref="modePill"
                                        type="button"
                                        class="composer-ghost ml-auto h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{ 'composer-steered': pickedWorkflow !== undefined }"
                                        :disabled="pickedWorkflow !== undefined"
                                        @click="modeOpen = !modeOpen"
                                        :aria-expanded="modeOpen"
                                        aria-label="Agent mode"
                                    >
                                        <Icon :name="modeIcon" class="text-2xs text-link" />
                                        <span class="@max-md:hidden">{{ modeLabel }}</span>
                                        <Icon name="chevron-down" class="text-2xs text-subtle" />
                                    </button>

                                    <!-- PERSONA — who the chat IS when it reaches outside: which of your accounts
                                         this turn may speak through, and how much of the toolbox it holds.

                                         A BADGE like the workflow pill beside it, for the same reason: unpicked
                                         it is a bare glyph, because most chats are nobody in particular and a
                                         name would be noise; picked it NAMES the persona in the active tint,
                                         because a message about to go out under somebody's account must say
                                         whose before it is sent, not after. Which is also why it stands AFTER
                                         mode rather than leading the group: a bare glyph at the group's edge is
                                         the easiest thing in the row to read as decoration, and the one pill
                                         whose unset state most needs to be noticed cannot afford that. -->
                                    <button
                                        ref="personaPill"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{
                                            'composer-active': conversation.actsAs.value !== undefined && pickedWorkflow === undefined,
                                            'composer-steered': pickedWorkflow !== undefined,
                                        }"
                                        :disabled="pickedWorkflow !== undefined"
                                        @click="personaOpen = !personaOpen"
                                        v-tooltip.top="
                                            conversation.actsAs.value !== undefined
                                                ? `This chat acts as ${personaName} — only its accounts are in reach`
                                                : `Act as one of your personas — only that person's accounts`
                                        "
                                        :aria-expanded="personaOpen"
                                        :aria-label="conversation.actsAs.value !== undefined ? `Acts as: ${personaName}` : `Acts as anyone`"
                                    >
                                        <Icon name="users" class="text-2xs" :class="conversation.actsAs.value !== undefined ? 'text-link' : ''" />
                                        <span v-if="conversation.actsAs.value !== undefined" class="max-w-32 truncate @max-md:hidden">
                                            {{ personaName }}
                                        </span>
                                        <Icon v-if="conversation.actsAs.value !== undefined" name="chevron-down" class="text-2xs text-subtle" />
                                    </button>

                                    <!-- RUN THROUGH — the row's last shaping control, and ONE where there were
                                         two. A loop and a workflow answer the same question about the next
                                         message (what is it run THROUGH) with answers the composer can only
                                         take one of, so they are one badge: picking is picking, and a pick
                                         replaces a pick. Two glyphs side by side said the same thing only by
                                         greying each other out, which is a rule you learn by tripping over it.

                                         Unpicked it is a bare neutral glyph — all the room a control most
                                         chats never use deserves. Picked it wears the CHOSEN thing's own icon
                                         and names it in the active tint, so nothing the two pills used to say
                                         about an armed state is lost: a composer about to spend money round
                                         after round, or to fan one message across paid sessions, still says so
                                         before the press rather than after it.

                                         A RUNNING loop takes it over entirely — the count replaces the name,
                                         the press ends it — and that outranks even an armed workflow, because
                                         stopping something already going is not a thing the next message
                                         decides, and a badge that buried the stop in a menu would leave the
                                         loop no way out but the fleet board. -->
                                    <button
                                        ref="runThroughPill"
                                        type="button"
                                        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                                        :class="{ 'composer-active': looping || pickedLoop !== undefined || pickedWorkflow !== undefined }"
                                        @click="looping ? endLoop() : (runThroughOpen = !runThroughOpen)"
                                        v-tooltip.top="runThroughHint"
                                        :aria-pressed="looping"
                                        :aria-expanded="looping ? undefined : runThroughOpen"
                                        :aria-label="runThroughLabel"
                                    >
                                        <Icon
                                            :name="runThroughIcon"
                                            class="text-2xs"
                                            :class="looping || runThroughName !== undefined ? 'text-link' : ''"
                                            :spin="looping"
                                        />
                                        <span v-if="activeLoop && looping" class="@max-md:hidden"
                                            >{{ activeLoop.iteration }}/{{ activeLoop.maxIterations }}</span
                                        >
                                        <template v-else-if="runThroughName !== undefined">
                                            <span class="max-w-32 truncate @max-md:hidden">{{ runThroughName }}</span>
                                            <Icon name="chevron-down" class="text-2xs text-subtle" />
                                        </template>
                                    </button>

                                    <button
                                        v-if="speechSupported"
                                        type="button"
                                        class="composer-ghost h-8 w-8 shrink-0 max-md:h-11 max-md:w-11"
                                        :class="{ 'composer-active': listening }"
                                        @click="toggleSpeech"
                                        v-tooltip.top="listening ? 'Stop dictation' : 'Dictate'"
                                        :aria-pressed="listening"
                                        aria-label="Dictate"
                                    >
                                        <Icon name="microphone" class="text-xs max-md:text-base" />
                                    </button>

                                    <!-- Stop is present for the whole live turn — generating OR parked on a plan /
                                     question / permission card. A parked turn still holds the conversation's run
                                     lock, so without this the user's only exits were answering a card they didn't
                                     want to answer or closing the tab. -->
                                    <button
                                        v-if="streaming"
                                        type="button"
                                        class="composer-send composer-stop shrink-0 max-md:h-11 max-md:w-11"
                                        @click="stop"
                                        v-tooltip.top="stopHint"
                                        :aria-label="stopLabel"
                                    >
                                        <Icon name="stop" class="text-sm" />
                                    </button>
                                    <!-- Send stays alongside Stop for the whole live turn: mid-turn text goes into the
                                     running turn where the harness takes it, and queues behind the turn where it
                                     doesn't. There is no state in which the composer has nowhere to put a message,
                                     so there is no state in which this button is missing. -->
                                    <button
                                        type="submit"
                                        class="composer-send shrink-0 max-md:h-11 max-md:w-11"
                                        :disabled="!canSend"
                                        v-tooltip.top="sendHint"
                                        aria-label="Send"
                                    >
                                        <Icon name="send" class="text-sm" />
                                    </button>
                                </div>
                            </form>

                            <p v-if="speechErrorMessage" class="px-1 text-2xs text-danger">{{ speechErrorMessage }}</p>
                            <p v-if="workflowFailure" class="px-1 text-2xs text-danger">{{ workflowFailure }}</p>
                            <p v-else-if="loopFailure" class="px-1 text-2xs text-danger">{{ loopFailure }}</p>
                            <!-- What the badge changes about the press, said under the box that is about to do
                                 it: the message is going to a design, not to this chat. The second sentence is
                                 what the greyed pills above would otherwise only say on hover — and a control
                                 that refuses has to name itself somewhere a touch device can read it. -->
                            <p v-else-if="pickedWorkflow" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="sitemap" class="shrink-0 text-2xs text-link" />Send starts “{{ pickedWorkflow.name }}” — this message is
                                what every step is asked to do. Model, effort, mode and looping are each step's own.
                            </p>
                            <!-- The loop badge's own sentence, and it carries the STOP CONDITION rather than just
                                 the name. This is the one badge in the row whose press starts something that goes
                                 on spending after the user has looked away, so "what ends it" belongs where the
                                 message is being written — not behind a hover on the pill, which no touch device
                                 will ever show anyone. -->
                            <p v-else-if="pickedLoop && !looping" class="flex items-center gap-1.5 px-1 text-2xs text-muted">
                                <Icon name="repeat" class="shrink-0 text-2xs text-link" />Send loops this message until it's met — ends on
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
             "check important info" line sits. It also carries the mobile keyboard inset for the whole
             footer: growing the bottom-most row in the flow shortens the scroller, and the composer stuck
             to its bottom edge rides up with it. Only rendered where the composer is, so the inset can
             never be needed while the row is absent. -->
        <div
            v-if="reachable && connected"
            class="mx-auto flex w-full max-w-[51rem] items-center gap-2 px-3 pb-2 text-2xs text-subtle"
            :style="mobile && keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 8}px` } : undefined"
        >
            <!-- The refusal owns this slot whenever there is one: a Send that won't go has to say what it
                 is waiting for, and the tooltip alone never reaches a touch device. Every form factor and
                 width, unlike the keyboard hint it displaces.
                 Keyboard hint is meaningless on a virtual keyboard (Enter is a newline there), and doesn't
                 earn its width in a narrow panel. An empty composer is the one moment message recall is
                 available, so the slot advertises it instead. -->
            <span v-if="sendBlock !== undefined" class="flex min-w-0 items-center gap-1 text-warning">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" />
                <span class="truncate">{{ sendBlock }}</span>
            </span>
            <span v-else-if="!mobile" class="@max-md:hidden">{{ composerHint }}</span>
            <div class="ml-auto flex items-center gap-3">
                <span v-if="contextRing" class="inline-flex items-center gap-1" v-tooltip.top="contextRing.tooltip">
                    <ProgressRing :value="contextRing.value" :class="contextRing.warn ? 'text-warning' : 'text-primary-500'" />
                    <span class="@max-xs:hidden">{{ contextRing.label }}</span>
                </span>
                <!-- The chip answers "am I about to get rate-limited" — hovering it opens the pool-by-pool
                     card beside the composer, and a click goes to the screen that answers "and what has it
                     cost me". -->
                <button
                    v-if="usageChip"
                    type="button"
                    class="inline-flex cursor-pointer items-center transition-colors hover:text-content"
                    @click="router.push('/sandbox/usage')"
                >
                    <UsageRing :headroom="usageChip.headroom"
                        ><span class="@max-xs:hidden">{{ usageChip.label }}</span></UsageRing
                    >
                </button>
                <button
                    type="button"
                    class="inline-flex items-center gap-1 transition-colors hover:text-content"
                    @click="router.push('/sandbox/agent')"
                >
                    <span class="inline-block h-1.5 w-1.5 rounded-full bg-success"></span> Ready · Manage
                </button>
            </div>
        </div>

        <!-- The four composer menus, each in the app's standard touch swap (ResponsiveOverlay): an anchored
             panel on desktop, a bottom sheet on a phone, one open flag either way. No height cap on any of them
             — the overlay measures the room its side of the pill actually has IN THE PILL'S OWN WINDOW and caps
             itself to it, so a picker fits whether this panel is docked in a column or floating in a window the
             user has since made short, and the `min-h-0` column passes that cap down to the scrolling list
             inside (see ChatModelPicker). -->
        <ResponsiveOverlay v-model="modelOpen" :anchor="modelPill?.el" header="Model" panel-class="w-[26rem]">
            <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="modeOpen" :anchor="modePill" cross="end" header="Agent mode" panel-class="w-56 p-1">
            <ChatModeMenu @selected="modeOpen = false" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="personaOpen" :anchor="personaPill" cross="end" header="Acts as" panel-class="w-80 p-1">
            <ChatPersonaMenu :picked="conversation.actsAs.value" @picked="pickPersona($event)" />
        </ResponsiveOverlay>
        <ResponsiveOverlay v-model="runThroughOpen" :anchor="runThroughPill" cross="end" header="Run this message through" panel-class="w-80 p-1">
            <ChatRunThroughMenu
                :loop="conversation.loopId.value"
                :workflow="conversation.workflowId.value"
                @loop="pickLoop($event)"
                @workflow="pickWorkflow($event)"
                @manage="manageRunThrough()"
            />
        </ResponsiveOverlay>
    </div>
</template>
