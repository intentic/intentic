<script setup lang="ts">
import { type IconName, growTextarea, MarkdownFigure, useDevice, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { copyCodeFromEvent } from "@intentic/ui/markdown";
import { CAPABILITY_CATALOG } from "@intentic-app/capability-catalog";
import { type AskQuestion, type CardDocument, planParts } from "@intentic/sandbox-contract";
import { type ComponentPublicInstance, computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import { clearQuestionDraft, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "../composables/chat/questionDraft";
import { effectiveAutoLand, effectiveOutageResume, formatElapsed } from "../composables/agents/agentStatus";
import { formatCredits } from "../composables/membership/creditMeter";
import { useAgents } from "../composables/agents/useAgents";
import { errandOf } from "../composables/chat/errands";
import { type ChatMessage, foldsIntoTurn, type PlanRequest, type TerminalHelpRequest } from "../composables/chat/transcript";
import { navigateInApp } from "../composables/mainWindow";
import { useMarkdown } from "../composables/useMarkdown";
import { openFileRefFromEvent } from "../composables/workspace/openFileRef";
import { invalidateWorkspace } from "../composables/workspace/useHistory";
import { usePaneView } from "../composables/chat/useChat";
import { landsByDefault } from "../composables/sandbox/rules";
import { useSandboxSettings } from "../composables/sandbox/useSandboxSettings";
import { openWorkTerminal, useWorkTerminals } from "../composables/terminal/useWorkTerminals";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useToolCalls } from "../composables/chat/useToolCalls";
import ChatAttachmentStrip from "./ChatAttachmentStrip.vue";
import ChatCard from "./ChatCard.vue";
import ChatCommandBlock from "./ChatCommandBlock.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import ChatDocumentBody from "./ChatDocumentBody.vue";
import { markedFragments } from "./commandPieces";
import { capabilityStatus, helpStatus, offerStatus, permissionStatus, planStatus, questionStatus } from "./cardStatus";
import ChatTodoList from "./ChatTodoList.vue";
import ChatToolRows from "./ChatToolRows.vue";
import ChatToolRun from "./ChatToolRun.vue";
import { present } from "./toolPresentation";

/* One transcript entry: user bubble, notice line, or the assistant turn's stack (thinking, tools, todos,
 * markdown text, plan card, question card, typing loader). Card decisions go straight to the useChat
 * singleton; per-message UI state (thinking fold, question picks) lives here, scoped to this instance. */

const props = defineProps<{
    message: ChatMessage;
    // True while this message is the turn currently being streamed.
    streaming: boolean;
    // What turnsOf folded into this turn: the user's "continue"-style nudges and the app's errands. Set only
    // on the turn's opening message, which renders them as its "↳ … ×N" trailer (see ChatTurn.folded).
    folded?: readonly ChatMessage[];
    /* This row is at or below the message an unsent edit is aimed at, and would go if that edit were sent
     * (ChatPane's `doomed`). Drawn faded and struck through, a preview, not a state: nothing has happened to
     * this message, and cancelling the edit restores it in place. */
    doomed?: boolean;
}>();

const {
    conversation,
    decidePlan,
    answerQuestion,
    cancelQuestion,
    decidePermission,
    decideServiceOffer,
    decideCapabilityOffer,
    decidePaymentOffer,
    declineBrowserHelp,
    declineTerminalHelp,
    awaitingDecision,
    isDeciding,
    editing,
    beginEdit,
    streaming: conversationStreaming,
} = usePaneView();

// The browser-help card's one real action leads AWAY from the chat: the live stage (and "hand back") are on
// /browsers, so the primary button is a navigation, not a decision: the card resolves from over there. It is
// therefore a LINK (ChatDecisionButton's `to`): an address to hover, and a Ctrl/⌘-click that puts the stage in
// its own tab beside the conversation asking for help, rather than replacing it.
/* THIS CARD'S ANSWER IS ALREADY ON ITS WAY, so none of its answers may be pressed again. The pressed button
 * holds itself (the kit's <Button> does that for any handler that returns a promise); this is the OTHER half,
 * the two buttons beside it, which are a different answer to the same question and were still live over a
 * decision that had already been made. Every card's answering buttons carry it. */
const settling = computed(() => isDeciding(props.message));

const router = useRouter();
const helpBrowserAt = (session: string): string => `/browsers/${session}`;

// The terminal-help card's, the same way: except the terminal is a PANEL under every view rather than a
// route, so this opens and focuses it on the agent's own session instead of navigating. The title is what the
// panel says about itself while the tab is on its way (useTerminalPanel), which for a handover is the ask.
const openHelpTerminal = (help: TerminalHelpRequest): void =>
    useTerminalPanel().openFocused(help.session, { title: `The agent needs you at this terminal`, detail: help.message });

/* The capability card's Connect is a decision AND a navigation: the reply un-parks the daemon's watch (the
 * agent now waits for the connection to come live), and the setup itself happens on the Capabilities page:
 * opened straight on the asked card, so the user lands on the form rather than the grid. "Open setup" while
 * connecting is the navigation alone, for whoever closed the page mid-setup. */
const capabilitySetupAt = (card: string): string => `/capabilities/${card}`;
const connectCapability = async (message: ChatMessage): Promise<void> => {
    // The reply is awaited, not fired and forgotten, so the button holds while it is in the air. The
    // navigation is not: the page it opens is where the setup happens, and it should not wait on the daemon.
    // In a popped-out chat it lands in the app's own window, which is where a setup form belongs.
    navigateInApp(router, capabilitySetupAt(message.capabilityOffer?.offer.card ?? ``));
    await decideCapabilityOffer(message, true);
};

// The card's one line of catalog prose, when the static catalog knows the card (a contributed card's frame
// still carries its name: the description line simply stays off).
const capabilityDescription = computed(() => {
    const card = props.message.capabilityOffer?.offer.card;
    return card === undefined ? undefined : CAPABILITY_CATALOG.find((entry) => entry.id === card)?.description;
});
const { mobile } = useDevice();

/* The landed notice's one-press offer (ChatMessage.noticeAction): flip THIS agent to holding its future work
 * on the branch: the moment the auto-land just fired is when "I'd rather have reviewed that first" is worth
 * exactly one press (the same reasoning as ChatPanel's "Enable auto-resume" on a limit banner). Per-agent,
 * not the sandbox default: the click happens inside one agent's conversation, so its honest blast radius is
 * that agent: Sandbox ▸ Agent owns the global. Gated on the CURRENT effective posture rather than on the
 * message, so pressing it once retires the offer from every landed notice at once, and a transcript replayed
 * into an already-holding agent never shows a stale one. */
const { agentById, setAutoLand, setResumeAfterOutage } = useAgents();
const { settings: sandboxSettings } = useSandboxSettings();
const holdOffer = computed(
    () =>
        props.message.noticeAction === `landHold` &&
        effectiveAutoLand(agentById(conversation.value.conversationId), landsByDefault(sandboxSettings.value?.rules ?? [])),
);
// Best-effort like markSeen: a failed write leaves the offer standing to press again.
const holdFutureLands = async (): Promise<void> => {
    await setAutoLand(conversation.value.conversationId, false).catch(() => undefined);
};

/* The outage notice's opt-out, on exactly the same reasoning one line up, and now with the same reach, which
 * is the whole repair. It used to switch the SANDBOX-wide setting off, because there was no per-agent override
 * to point it at; that made the pair lopsided in the worst direction, since a person regretting one automatic
 * retry would silently disarm every other agent that was mid-outage.
 *
 * `false` rather than null, and the difference matters: null would hand this chat back to a default that may
 * well say "resume", which is not what somebody pressing Stop means. Gated on the EFFECTIVE posture, so the
 * offer retires itself the moment this conversation stops resuming: whichever level answered. */
const outageOptOutOffer = computed(
    () =>
        props.message.noticeAction === `outageOptOut` &&
        effectiveOutageResume(agentById(conversation.value.conversationId), sandboxSettings.value?.resumeAfterOutage),
);
const stopResumingOutages = async (): Promise<void> => {
    await setResumeAfterOutage(conversation.value.conversationId, false).catch(() => undefined);
};

/* The dependency reconcile's one press: a REVEAL, not a setting. The daemon started an install because the
 * turn's landed delta needed one, and the only thing left to offer is the terminal it is running in.
 *
 * Gated on the install still RUNNING, on the same reasoning as the two offers above: a transcript replayed after
 * it finished would otherwise open a dead pane, which is the row-of-corpses failure useWorkTerminals exists to
 * avoid. `running` comes from the live terminals list, so the offer retires itself the moment the install ends
 * and the notice settles into a plain sentence about something that happened. */
const { rows: liveWork } = useWorkTerminals();
// The install runs as a panel job keyed `<project>--install` (workspace-setup.ts installPanelKey), so the
// suffix is what names it among the live work terminals without this file having to know the project's dir.
const installSession = computed(() => liveWork.value.find((row) => row.session.endsWith(`--install`))?.session);
const depsInstallOffer = computed(() => props.message.noticeAction === `depsInstall` && installSession.value !== undefined);
const watchDepsInstall = (): void => {
    if (installSession.value !== undefined) {
        openWorkTerminal(installSession.value);
    }
};

/* The routed-turn notice's one press, the landed/outage bargain applied to automatic tier selection: the first
 * time a conversation quietly runs on a cheaper model is when "keep this chat on my pick" is worth exactly one
 * press. It flips the conversation's OWN standing veto (Conversation.tierHold, persisted by the daemon per
 * conversation), never the sandbox setting: the click happens inside one chat, so that is its honest blast
 * radius. Gated on the current toggle, so a replayed transcript inside an already-holding chat shows a settled
 * sentence rather than a stale offer. */
const tierHoldOffer = computed(() => props.message.noticeAction === `tierHold` && !conversation.value.tierHold.value);
const holdTier = (): void => {
    conversation.value.setTierHold(true);
};

// Whimsical status words cycled while a turn is streaming (Claude Code style).
const LOADER_WORDS = [
    `Thinking`,
    `Pondering`,
    `Perusing`,
    `Conjuring`,
    `Noodling`,
    `Musing`,
    `Cogitating`,
    `Ruminating`,
    `Percolating`,
    `Brewing`,
    `Tinkering`,
    `Scheming`,
    `Untangling`,
    `Synthesizing`,
];

// --- Markdown / rendering --------------------------------------------------------------------
// Both prose surfaces go through the one composable (see useMarkdown), which splits a live turn into settled
// + still-writing halves and renders anything finished in one pass. One renderer per message view, held for
// the component's life: the list is keyed by message id, so an instance tracks one message throughout.
/* Whose copy of the workspace this conversation's prose is about (workspaceScope). An isolated conversation
 * works in its own checkout, so a file it names in an answer is the one in THAT tree: the shared tree's file
 * of the same path is a different file, or none at all, and linking there is how "I wrote docs/plan.md" led to
 * a not-found page. A shared-workspace conversation is undefined: /work IS its tree. */
const linkAgent = computed(() => (conversation.value.isolated.value ? conversation.value.conversationId : undefined));

const body = useMarkdown(
    () => props.message.text,
    () => props.streaming,
    linkAgent,
);
// A plan card's body arrives whole with the card, so it never streams.
const plan = useMarkdown(() => (props.message.plan ? planParts(props.message.plan.text).body : ``), false, linkAgent);

const planTitle = (request: PlanRequest): string => planParts(request.text).title ?? `Proposed plan`;

/* Whether this bubble ALREADY draws the document a card is carrying, as the card of the write that produced it
 * (a markdown Write renders as prose, see toolPresentation). The question or plan card then opens FOLDED: the
 * reader has the document on screen, and a second full copy under the first is length, not emphasis.
 *
 * Folded, never dropped. Which bubble a write landed in depends on where the model happened to break its prose,
 * so "it is somewhere above" is not a promise this can make, and the failure worth avoiding is the one that
 * costs a reader the document, not the one that costs them a click. */
const documentDrawn = (document: CardDocument | undefined): boolean =>
    // Asked of the card's OWN presenter rather than of the shared rule underneath it, so "already drawn" means
    // drawn: a write that failed carries content the card refuses to render as a document, and a question card
    // must not fold its copy away on the strength of a document nobody can see.
    document !== undefined && (props.message.tools ?? []).some((tool) => present(tool).document?.path === document.path);

// One delegated listener for every control the rendered markdown carries: a code block's copy button and the
// file links a mentioned path becomes. Both live inside v-html, so neither can hold a component of its own.
// Copying is bound to the PRESS as well (see copyCodeFromEvent): a live turn rewrites its markdown every frame,
// which destroys the button between mousedown and mouseup, and the click then never reaches it.
const onMarkdownClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    openFileRefFromEvent(event);
};

// --- Thinking fold / typing loader -----------------------------------------------------------
// Manual override of the thinking section's expanded state. When unset, it defaults to expanded while the
// turn streams and collapsed once done.
const thinkingOverride = ref<boolean>();
const isThinkingOpen = computed(() => thinkingOverride.value ?? props.streaming);
const toggleThinking = (): void => {
    thinkingOverride.value = !isThinkingOpen.value;
};

// The permission card's header line: the bridge's own rendered prompt sentence, else its short noun phrase,
// else the bare tool name, so the card reads like Claude Code's prompt rather than a raw tool dump.
const permissionTitle = computed(() => {
    const permission = props.message.permission;
    if (permission === undefined) {
        return ``;
    }
    return permission.title ?? permission.displayName ?? permission.toolName;
});

/* WHETHER THE COMMAND IS SHOWING, when a sentence is standing in front of it. Closed to start, and only ever
 * reachable at all when there IS a sentence: with none, the program is the card's body and there is nothing to
 * disclose. Local to the card and not persisted, deliberately, this is a per-decision choice, and remembering
 * "I opened the last one" would silently expand a card the next decision may not need it on.
 *
 * The FRAGMENTS are what make closing it defensible: they are the part of the command the gate actually
 * stopped it for, and they stay on the card whether it is open or closed. Hiding the command must never hide
 * the evidence, or a fold has turned a wall of text into a card nobody can audit. */
const commandOpen = ref(false);
const commandFragments = computed(() => {
    const program = props.message.permission?.program;
    return program === undefined ? [] : markedFragments(program.text, program.spans);
});

// The approved run's latest status line off the provider's stream: what the card shows living while the
// receipt is still pending. Newest wins: a status line is a spinner label, not a log.
const serviceStatus = computed(() => {
    const offer = props.message.serviceOffer;
    if (offer === undefined || offer.receipt !== undefined) {
        return undefined;
    }
    for (let i = (offer.events?.length ?? 0) - 1; i >= 0; i -= 1) {
        const event = offer.events?.[i];
        if (event?.event === `status`) {
            return event.text;
        }
    }
    return undefined;
});

// Keep the loader visible for the whole live turn, not just before the first token. The model streams a
// preamble sentence and then goes quiet while it runs tools and thinks: text is present but the turn isn't
// done. Anchored at the bottom of the assistant stack, the loader tells the user work is still in flight;
// it disappears only when streaming ends or a card takes over the prompt.
//
// A pending card is the one case where the turn is still streaming (its fetch stays open) while nothing is
// being computed: the card is the prompt, so the loader must yield to it. Read the CONVERSATION's flag, not
// this message's own cards: a card parks the whole turn but hangs on whichever bubble was current when it
// arrived, which isn't always the bubble the loader trails (a plan nulls the turn's bubble, so later frames
// open a fresh one below the card). Per-message, that left "Scheming… (107s)" ticking under a permission
// prompt the agent was already blocked on.
const showTyping = computed(() => props.streaming && !awaitingDecision.value);

/* THIS NOTICE'S WAIT, WHILE IT IS STILL RUNNING (see ChatMessage.noticeWait). The message says which wait it
 * describes; the CONVERSATION says whether that wait is still on. Pairing the two is what keeps a replayed
 * transcript honest: the line stays in the record, and it only spins while there is genuinely something to wait
 * for. Undefined the rest of the time, which is also what turns the shared clock off again. */
const pendingWait = computed(() =>
    props.message.noticeWait === `credentialRenewal` ? conversation.value.failures.credentialRenewal.value : undefined,
);

// The shared second-ticking clock, armed for every live readout in this view: the turn's elapsed counter, the
// retry countdown, and a pending notice's wait. Armed whenever any of them is showing, which is why a notice's
// wait counts too: it outlives the turn it describes, and a frozen "0s" beside a spinner reads as a hang.
const now = useNow(() => props.streaming || pendingWait.value !== undefined);

// Cycling status-word loader shown while the turn streams. The conversation owns the start instant: send()
// records it when the command leaves, and a later attach restores the daemon's instant. Deriving from that
// source means a view mounted halfway through a turn starts halfway through its counter too.
const loaderSeconds = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? 0 : Math.max(0, Math.floor((now.value - startedAt) / 1000));
});
// The readout itself is the shared elapsed format, so a turn that runs long reads "9m 12s" rather than "552s".
const loaderElapsed = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? undefined : formatElapsed(startedAt, now.value);
});
/* WHAT THE LOADER SAYS WHILE THE TURN IS ONLY WAITING ON ITS CHILDREN, which is the one stretch the whimsical
 * words are wrong about. A turn that delegated has written its "I'll come back with their results" and gone
 * quiet: nothing of its own is running, the transcript looks finished, and the only thing between it and the
 * end is agents working somewhere else. "Percolating… (6m 12s)" over that reads as a model that has hung.
 *
 * The count is the roster's: the same number the board's card and the chat rail already say, so the three
 * never disagree about how many are out (agentStatus.ts's rule). */
const liveSubagents = computed(() => agentById(conversation.value.conversationId)?.subagents?.running ?? 0);
const loaderWord = computed(() =>
    liveSubagents.value > 0
        ? `Waiting on ${liveSubagents.value} subagent${liveSubagents.value === 1 ? `` : `s`}`
        : (LOADER_WORDS[Math.floor(loaderSeconds.value / 2) % LOADER_WORDS.length] ?? `Thinking`),
);

/* THE PROVIDER IS FAILING AND THIS TURN IS RIDING IT OUT (the provider_retry frame). It takes the loader line
 * over, because it answers the one question the cycling word cannot: the agent is not stuck, it is waiting, and
 * here is when it tries again.
 *
 * This line is what makes the long in-turn retry budget safe to have. Without it a turn absorbing an outage looks
 * identical to a hung one for minutes at a stretch, and the move a user makes against an apparent hang is Stop:
 * the only move that actually throws away the work the turn has already done. Rides the same one-second tick as
 * the elapsed counter, so the countdown moves and stale-looks impossible. */
const providerRetry = computed(() => conversation.value.providerRetry.value);
// "and here is when it tries again" holds only when the harness said when: Claude's does. Codex reports which
// attempt it is on and nothing else (codex-agent.ts), so its line drops the countdown rather than name an
// instant the retry never agreed to.
const retryWait = computed(() => {
    const nextAttemptAt = providerRetry.value?.nextAttemptAt;
    return nextAttemptAt === undefined ? `retrying` : `retrying in ${Math.max(0, Math.round((nextAttemptAt - now.value) / 1000))}s`;
});
/* 529 is capacity, 429 is the allowance, everything else in this frame is a fault. All three are worth telling
 * apart because each points somewhere different: "at capacity" says the request was fine and a smaller model
 * would probably go through right now, "rate-limiting" says the account has been asked for too much and only
 * time or another account fixes it, and "not responding" says nobody's request is getting through. Told none of
 * that, a user watching a long wait goes looking for a fault in their own work. */
const retryReason = computed(() =>
    providerRetry.value?.status === 529 ? `at capacity` : providerRetry.value?.status === 429 ? `rate-limiting` : `not responding`,
);

// --- Interactive question card ---------------------------------------------------------------
// Selection state for a pending question card, keyed by question index. Held here because it is UI state of
// this card, but mirrored to localStorage per requestId (see questionDraft) so a reload, which reattaches to
// the same still-parked card: doesn't make the user pick everything again.
//
// One list of picks per question, with OTHER_LABEL standing in for the free-text row, is the whole reason this
// card has no state to reconcile: "Other" is an option, so choosing it is the same act as choosing any other
// option and single-select falls out of the list arithmetic below. `otherTexts` is not a parallel selection:
// it is the words that belong to that one row, kept whether or not the row is currently picked, so clicking
// away to re-read the options and clicking back doesn't cost the user what they typed.
const selections = ref<Record<number, string[]>>({});
const otherTexts = ref<Record<number, string>>({});
// One free-text field per question row, kept by index so picking the row can put the caret straight into it.
const otherInputs = ref<Record<number, HTMLTextAreaElement | undefined>>({});
// Manual auto-grow, the composer's own: reset to one line, then size to content up to the max-height. An answer
// in your own words is the one that can run long, and a box that hides its own start while you write it is the
// box you stop trusting.
const growOther = (el: HTMLTextAreaElement | undefined): void => {
    growTextarea(el, 192);
};
// Sizing on attach, not just on typing: the field is rendered by picking the row, and a draft restored after a
// reload puts it on screen with paragraphs already in it. A tick later, because the ref lands while the card is
// still being built and a detached textarea has no height to read.
const setOtherInput = (index: number, el: Element | ComponentPublicInstance | null): void => {
    const field = el instanceof HTMLTextAreaElement ? el : undefined;
    otherInputs.value[index] = field;
    void nextTick(() => growOther(field));
};

// Load the draft when a pending card appears (mount, or the frame arriving mid-turn), and drop it the moment
// the card settles: answered, dismissed, or frozen `cancelled` by a stop. One watcher for both because they
// are the same event seen from either side: this card is no longer taking picks.
watch(
    () => [props.message.question?.requestId, props.message.question?.status] as const,
    ([requestId, status]) => {
        if (requestId === undefined) {
            return;
        }
        if (status !== `pending`) {
            clearQuestionDraft(requestId);
            return;
        }
        // Read back against the live card: a draft written by a build with different rules is normalized to
        // picks this card would accept rather than replayed as stored (see questionDraft.normalize).
        const draft = readQuestionDraft(requestId, props.message.question?.questions ?? []);
        selections.value = draft.selections;
        otherTexts.value = draft.otherTexts;
    },
    { immediate: true },
);

// Both refs are replaced wholesale on every edit (see toggleOption/setOther), so a shallow watch sees them all.
watch([selections, otherTexts], ([picks, texts]) => {
    const question = props.message.question;
    if (question?.status !== `pending`) {
        return;
    }
    writeQuestionDraft(question.requestId, { selections: picks, otherTexts: texts });
});

const isSelected = (index: number, label: string): boolean => (selections.value[index] ?? []).includes(label);

// Picking, for every row including Other. Single-select replaces, multi-select accumulates, and clicking the
// row you are on takes it back: nothing here reaches across to clear a different piece of state, because
// there is no longer a different piece of state to clear.
const toggleOption = (question: AskQuestion, index: number, label: string): void => {
    const current = selections.value[index] ?? [];
    const next = question.multiSelect
        ? current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label]
        : current.includes(label)
          ? []
          : [label];
    selections.value = { ...selections.value, [index]: next };
    // Picking Other is a request to write, so the caret goes where the writing happens; the field is rendered
    // by that same pick, hence the tick.
    if (label === OTHER_LABEL && next.includes(OTHER_LABEL)) {
        void nextTick(() => otherInputs.value[index]?.focus());
    }
};

/* HOW MANY ANSWERS THIS QUESTION TAKES, SAID THREE WAYS AT ONCE. A multi-select question rendered with round
 * marks is a card that lies: every convention the user has ever met reads a circle as "one of these", so they
 * pick one, submit, and never learn the other options were theirs to take too. The shape carries it first
 * (square marks are a checkbox list everywhere else), the words carry it for anyone who reads before clicking,
 * and the ARIA role carries it for anyone who cannot see either: one fact, three channels, no card where a
 * reader has to click to find out which kind it is. */
const markFor = (question: AskQuestion, selected: boolean): IconName => {
    if (question.multiSelect) {
        return selected ? `check-square` : `square`;
    }
    return selected ? `check-circle` : `circle`;
};

// The count is the second half of the promise the hint makes: pick one and it says "1 selected" rather than
// falling silent, so a list that stayed open answers back that it is still taking picks.
const pickedCount = (index: number): number => (selections.value[index] ?? []).length;

const otherValue = (index: number): string => otherTexts.value[index] ?? ``;
const setOther = (index: number, value: string): void => {
    otherTexts.value = { ...otherTexts.value, [index]: value };
};
const onOtherInput = (index: number, event: Event): void => {
    const el = event.target as HTMLTextAreaElement;
    setOther(index, el.value);
    growOther(el);
};

// A picked Other row with nothing written in it is an unfinished answer, not an empty one: it holds Submit
// rather than being quietly dropped, which would send the agent something other than what the card shows.
const otherPending = (index: number): boolean => isSelected(index, OTHER_LABEL) && otherValue(index).trim().length === 0;

// What this question answers with: the picked labels, with the Other row swapped for what was typed into it.
// The sentinel never leaves this function: the agent is answered in the user's own words.
const picksFor = (index: number): string[] =>
    (selections.value[index] ?? []).flatMap((label) => {
        if (label !== OTHER_LABEL) {
            return [label];
        }
        const typed = otherValue(index).trim();
        return typed.length > 0 ? [typed] : [];
    });

const canSubmit = computed(() => props.message.question?.questions.every((_, index) => picksFor(index).length > 0 && !otherPending(index)) ?? false);

// Hands the promise back rather than dropping it on the floor: that promise is what holds Submit while the
// answers are in the air, and a `void` in front of it is the button going stale under an impatient second
// click (see @intentic/ui's <Button>).
const submitAnswers = async (): Promise<void> => {
    const question = props.message.question;
    if (!question || !canSubmit.value) {
        return;
    }
    const answers: Record<string, string[]> = {};
    question.questions.forEach((q, index) => {
        answers[q.question] = picksFor(index);
    });
    await answerQuestion(props.message, answers);
};

/* Enter submits, Shift+Enter breaks the line: the chat composer's bargain, held to here so one keystroke does
 * not mean two things depending on which box the caret is in. On mobile Enter is always a newline: a virtual
 * keyboard has no Shift+Enter, and Submit is a button away. */
const otherKeydown = (event: KeyboardEvent): void => {
    if (event.key !== `Enter` || event.isComposing || event.shiftKey || mobile.value) {
        return;
    }
    event.preventDefault();
    submitAnswers();
};

// A DECIDED question card is the record of the decision, so it keeps every option that was on the table and
// marks the one(s) taken: read back a week later, "Your original ×" means nothing without the alternatives it
// was chosen over. A free-text answer belongs to no option, so it joins the list as a row of its own: it is
// the one answer that would otherwise vanish from the transcript entirely.
interface DecidedOption {
    readonly label: string;
    readonly description?: string;
    readonly preview?: string;
    readonly picked: boolean;
}

const decidedOptions = (question: AskQuestion): DecidedOption[] => {
    const picks = props.message.question?.answers?.[question.question] ?? [];
    const typed = picks.filter((pick) => !question.options.some((option) => option.label === pick));
    return [
        ...question.options.map((option) => ({ ...option, picked: picks.includes(option.label) })),
        ...typed.map((label) => ({ label, picked: true })),
    ];
};

/* GOING BACK lives in the column's margin now, beside the answer rather than on the bubble: see ChatForkCut.
 * The two controls that used to hang off a user message (a history icon that rewound in place, a pencil that
 * copied the chat into a new tab) were the same decision asked twice in different words, and neither said what
 * would happen to the files. One mark, one menu, three named outcomes.
 *
 * --- EXCEPT FOR THE ONE THAT IS ABOUT THIS MESSAGE --------------------------------------------------------
 *
 * A pencil is back, and the distinction is worth stating because the old one was removed on purpose. That
 * pencil was a FORK wearing an edit's clothes: it copied the chat into a new tab, left the files where they
 * were, and called it editing: the mislabelling was the whole complaint against it. This one edits. It aims
 * the composer at this message; the send it eventually gets rewinds to this point, files and all, before the
 * new prompt goes out. Nothing at all happens on the click: see Conversation.editing.
 *
 * IT IS ON THE PROMPT because that is where the hand goes. The cut's mark stands level with the END of an
 * answer, which is exactly right for "carry on from there another way" and exactly wrong for "I named the
 * wrong file": a reader fixing their own sentence looks at their own sentence, finds nothing there, and either
 * retypes it from scratch or never finds the affordance at all. So the two marks now bracket the turn: the
 * edit at the prompt that opened it, the fork menu at the close of the answer, and they share the one gutter
 * column, so the pair reads as one idea rather than as two controls that happen to both be near a turn.
 *
 * What the cut GREYS OUT, this HIDES, and the difference is deliberate: a menu row that vanished would leave a
 * menu whose shape changed under the reader, while a margin mark is invisible until hovered anyway: there is
 * no gap to explain. No checkpoint behind the message means the files cannot come back to it, and an edit that
 * quietly kept today's files would start the new turn on the very work it was meant to discard. Mid-turn it
 * goes for the reason the cut's file rows wait: a rewind under a running agent is the one interleaving the
 * daemon's lease exists to refuse (agent/rewind.ts). And a prompt whose OWN edit is already armed offers no
 * pencil, because the composer is holding it.
 *
 * An ERRAND (a prompt the app composed and sent on the user's behalf) is excluded by the BRANCH this control
 * lives in rather than by a condition of its own: those render as their own row (see `errand` below) and never
 * reach the prompt bubble the pencil hangs off. Editing one would mean editing our prose anyway. */
const editable = computed(
    () =>
        props.message.role === `user` &&
        props.message.rewindIndex !== undefined &&
        !conversationStreaming.value &&
        editing.value?.id !== props.message.id,
);

const startEdit = (): void => {
    beginEdit(props.message);
};

// --- Long prompt clamp (see .chat-prompt-text) ------------------------------------------------
// The bubble is clamped in CSS; whether the clamp actually bites is a question of wrapping, and wrapping
// depends on a panel width the user can drag. So the element is measured rather than its text guessed at,
// and re-measured whenever it resizes: a prompt that fits at a wide panel clips at a narrow one, and a
// faded-out prompt with no way to open it is just lost text.
const bubble = ref<HTMLElement>();
const overflowing = ref(false);
const expanded = ref(false);
watch(
    bubble,
    (element, _previous, onCleanup) => {
        if (element === undefined) {
            overflowing.value = false;
            return;
        }
        const observer = new ResizeObserver(() => {
            // Open, the clamp is off and the box always fits: there is nothing to measure, and measuring
            // would clear the flag that keeps the collapse control on screen. The next collapse re-measures.
            if (!expanded.value) {
                overflowing.value = element.scrollHeight > element.clientHeight + 1;
            }
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);

// A message that folded into the turn above never pins: sticking it would cover the very prompt it defers to
// (two sticky siblings in one turn section share the same top edge, and the later one wins). A bare "keep
// going" stays an ordinary bubble sliding beneath the pinned question; an errand gets the row below.
const defers = computed(() => foldsIntoTurn(props.message));

/* AN ERRAND: a prompt the app composed and sent on the user's behalf (errands.ts). It is rendered by its
 * label, at the meta tier where the tool cards answering it will appear, because its text is a paragraph of
 * OUR prose: shown as a user bubble it read as something they had typed, and cost the panel six clamped lines
 * of it. The words themselves stay one click away: a message nobody typed must still be auditable, and "what
 * exactly did you tell my agent to do?" is a fair question with a conflict half-resolved. */
const errand = computed(() => errandOf(props.message));
const errandOpen = ref(false);

/* THE NOTES THE DAEMON ADDED TO A TURN'S MESSAGE (ChatMessage.notes): the errand row's reasoning applied to
 * the other half of the same problem.
 *
 * An errand is our prose sent AS the user; these are our prose sent WITH them, prepended to what they typed
 * before the model reads it: a rebase that moved the branch out from under the agent, dependencies that are
 * behind, workspace context retrieved for the message. They change what the agent does, and the chat's only
 * trace of any of them used to be a single muted line paraphrasing the rebase, so an agent visibly acting on
 * instructions had those instructions nowhere on screen and nowhere to look for them.
 *
 * Same answer as the errand, and it must stay the same answer: collapsed to one line, opening to the words
 * verbatim. Summarising is what caused this; a shorter paraphrase in place of the text would be the same bug
 * with better wording. */
const notesOpen = ref(false);
const noteTitles = computed(() => (props.message.notes ?? []).map((note) => note.title).join(`, `));

/* Verbatim, minus the markdown heading most of these notes open with. That heading is addressed to a model
 * reading markdown; drawn here it is two literal hashes above a row that already names the note, so it reads as
 * a formatting failure and says nothing the label did not. Only a heading, and only the FIRST line: everything
 * below it is the note's prose and stays exactly as the agent got it. */
const noteBody = (text: string): string => text.replace(/^#{1,6} .*(\n|$)/, ``).trim();

/* THE PINNED PROMPT'S TRAILER: things have happened to this turn since it was asked, and the pin must not
 * pretend otherwise. One line, so it names the LAST of them and counts how many said the same thing: in the
 * user's own words for a nudge (the lexicon keeps those short) and by label for an errand. In flow whenever
 * there is something to say rather than only while pinned: an element appearing at the pin threshold would
 * change the row's height there, which yanks the transcript (the same rule .chat-prompt-text's clamp obeys). */
const foldedLabel = (message: ChatMessage): string => errandOf(message)?.label ?? message.text.trim();
const trailer = computed(() => {
    const folded = props.folded ?? [];
    const last = folded.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const label = foldedLabel(last);
    return { label, count: folded.filter((message) => foldedLabel(message) === label).length };
});

// Whether this transcript draws its tool calls or hides each turn's run behind one mark (see useToolCalls.ts).
const { showToolCalls } = useToolCalls();

// --- Pinned state (see .chat-prompt-pinned) ----------------------------------------------------
/* CSS has no way to ask whether a sticky element is currently stuck, and the band under a prompt must only be
 * painted while it is: on an in-flow row it would read as a card floating over the transcript, and it would
 * paint over the neighbouring rows the negative margins reach into.
 *
 * THE STATE IS MEASURED, NOT INFERRED. The row is offset a pixel above the scroller's top edge (`top: -1px`),
 * so a stuck row's top edge sits above that edge and an in-flow one's does not: one comparison, true whenever
 * it is asked.
 *
 * It used to be inferred instead, from an IntersectionObserver's ratio: that same pixel is clipped once the row
 * pins, so the ratio drops below 1. That reads the same in the ordinary case, and is wrong in a way that LASTS,
 * because the flag was then a remembered answer and an observer only speaks at a threshold crossing. Two ways
 * it stops speaking, both leaving the flag frozen at whatever it last held:
 *
 *   - AN OBSERVER GOES SILENT WHEN ITS TARGET CHANGES DOCUMENT. Popping the chat out adopts these very rows
 *     into another window (see the clamp's observer above), and an observer built in the window they came from
 *     reports nothing about them afterwards, measured, not inferred: it reported once before the move and
 *     never again, through a scroll that pinned the row in its new home. The flag is reset to false as the row
 *     is rebuilt, so the band simply never painted there.
 *   - A report that arrives stale. The callback takes a queue, not a state, and reading the first of a batch
 *     answers with the older of two frames.
 *
 * Either way the prompt sticks with the flag still saying otherwise, and the band goes unpainted for the rest
 * of the turn: the answer then scrolls visibly THROUGH the pinned prompt, which is the bug this replaces.
 *
 * So the observer is demoted to a gate over a listener that carries the correctness on its own. The scroller's
 * own scroll is what re-reads the box: one rect per on-screen prompt, on an event where layout is already
 * settled, and the gate only takes that listener OFF a row scrolled out of the transcript. A gate that never
 * speaks therefore costs a listener that never comes off, which is the harmless direction to fail in. */
const row = ref<HTMLElement>();
const pinned = ref(false);

watch(
    row,
    (element, _previous, onCleanup) => {
        pinned.value = false;
        if (element === undefined || props.message.role !== `user` || defers.value) {
            return;
        }
        /* The transcript scroller is the only scrolling ancestor the pin is relative to, so it is both what the
         * row is measured against and what the gate is rooted at. A row mounted outside one cannot be stuck to
         * anything: it stays an ordinary bubble rather than pinning against the viewport by accident. */
        const scroller = element.closest(`.chat-scroller`);
        if (scroller === null) {
            return;
        }
        /* Half a pixel into the row's one-pixel offset: below the stick point the row's top edge is still at or
         * under the scroller's, above it the offset has lifted it clear, and the midpoint separates the two
         * whatever fractional scroll position or display scaling the two rects come back with. The scroller's
         * own edge is its PADDING edge, which is what a sticky offset resolves against. */
        const sync = (): void => {
            const edge = scroller.getBoundingClientRect().top + scroller.clientTop;
            pinned.value = element.getBoundingClientRect().top < edge - 0.5;
        };
        let listening = false;
        const listen = (on: boolean): void => {
            if (on === listening) {
                return;
            }
            listening = on;
            if (on) {
                scroller.addEventListener(`scroll`, sync, { passive: true });
            } else {
                scroller.removeEventListener(`scroll`, sync);
            }
        };
        // Default threshold: the gate asks only whether the row is in the scrollport, and an isIntersecting
        // flip is the one transition an observer always reports. Scrolled away, the flag is nobody's business
        // and the listener comes off; arriving, this is also what re-measures the row. The freshest entry, since
        // a callback takes a queue and the last of it is the frame that just happened.
        const observer = new IntersectionObserver(
            (entries) => {
                listen(entries.at(-1)?.isIntersecting === true);
                sync();
            },
            { root: scroller },
        );
        observer.observe(element);
        // Measured and listening from the outset, rather than from the gate's first word: a row mounted where it
        // already sticks (a transcript restored to its own bottom) is pinned before anything scrolls, and a gate
        // that never reports at all must not be what decides whether this row is ever measured again.
        sync();
        listen(true);
        onCleanup(() => {
            observer.disconnect();
            listen(false);
        });
    },
    { immediate: true, flush: `post` },
);

// A clamped box has no scrollbar and cannot be scrolled by hand, so any scroll it reports came from the
// browser revealing something inside it: find-in-page landing on a match below the fold, or a screen reader
// moving to it. Both mean the same thing: open the message, and put the box back where it belongs. An OPEN
// box is different: it owns a real scrollbar (see .chat-prompt-open), so its scrolls are the user reading
// and must be left alone.
const onBubbleScroll = (): void => {
    if (expanded.value) {
        return;
    }
    if (bubble.value !== undefined && bubble.value.scrollTop > 0) {
        expanded.value = true;
        bubble.value.scrollTop = 0;
    }
};

// A clamped bubble is its own expand target: the chip is only where that affordance is drawn, and a cut
// prompt is a thing you reach for by pointing at the text, not by finding a 20px control. One direction
// only: a body click that FOLDED the box would fire under a reader who is still inside it, and the chip is
// on screen throughout. Guarded on a live selection so dragging text out of a prompt doesn't unfold it.
const onBubbleClick = (): void => {
    // The selection asked of the bubble's OWN window: out in a floating one, the drag being guarded against lives there,
    // and this realm's selection is a different (always-collapsed) one.
    const selection = bubble.value?.ownerDocument.defaultView?.getSelection() ?? window.getSelection();
    if (expanded.value || !overflowing.value || selection?.isCollapsed === false) {
        return;
    }
    expanded.value = true;
};

const toggleExpanded = (): void => {
    expanded.value = !expanded.value;
    // Fold back up showing the top, and do it NOW, before Vue re-applies the clamp: a leftover offset from
    // reading inside the open bubble would be clamped by the relayout, and that fires the very scroll event
    // onBubbleScroll reads as find-in-page: reopening the message the click just closed.
    if (!expanded.value && bubble.value !== undefined) {
        bubble.value.scrollTop = 0;
    }
};

// The chip row with thumbs resolved, by PATH and only by path: the object URL this window minted when the file
// was staged if it was staged here, else one re-minted from the workspace bytes for a restored, replayed or
// cached bubble (attachmentPreview: reactive, so the name chip flips to a thumb when the bytes land).
const attachmentThumbs = computed(() =>
    (props.message.attachments ?? []).map((attachment) => ({
        name: attachment.name,
        path: attachment.path,
        previewUrl: attachmentPreview(attachment.path),
    })),
);

// Whether the attachment MAY sit beside the prompt instead of stacked above it. Not a width test: the @lg
// container query in the template owns that half. What is settled here is whether the arrangement can pay for
// itself at all, since the only thing it buys is height on the pinned row:
//   · EXACTLY ONE attachment. Beside the bubble they stack vertically, so N of them cost N × 62px where the
//     row above the bubble costs 56 once however many there are. One is the case that always wins: the pair
//     costs the taller of the two rather than their sum. Two only wins past a three-line prompt, three only
//     at the six-line cap (measured: three beside a one-line prompt came out 80px TALLER than the row does),
//     and past that it always loses. A rule that held only sometimes would have to measure the bubble and
//     reflow the layout as the panel resizes; one attachment is the honest version of it.
//   · AN IMAGE. Anything else renders as a chip carrying its whole filename, and a fixed-width column cannot
//     absorb an arbitrary width.
//   · A PROMPT TO SIT BESIDE. An attachment-only message has nothing to align against.
const attachmentsAside = computed(
    () => props.message.text.length > 0 && attachmentThumbs.value.length === 1 && attachmentThumbs.value[0]?.previewUrl !== undefined,
);

/* WHEN THE MESSAGE WAS SENT, as the wall-clock minute alone: "14:32". Absolute rather than "3h ago", the
 * question a transcript raises is which sitting a turn belongs to, which a relative age answers only for the
 * last hour and then has to keep re-rendering to stay true.
 *
 * The DAY is not in the label, because it is already on screen: the transcript draws a marker naming the day
 * wherever the date changes (ChatPane's dayMarks), so every stamp reads under one. That is what buys the label
 * its place: five characters fit the margin beside the bubble, where the twenty of "Aug 10, 2026, 14:32" did
 * not, and the full day and minute stay one hover away in the tooltip for the one reader who wants them without
 * scrolling up to the marker.
 *
 * Undefined on every row that has no stamp of its own (see ChatMessage.sentAt), and the label is not drawn at
 * all rather than saying so. */
const sentClock = computed(() => (props.message.sentAt === undefined ? undefined : formatClock(props.message.sentAt)));
const sentExact = computed(() => (props.message.sentAt === undefined ? undefined : formatDateTime(props.message.sentAt)));
</script>

<template>
    <!-- The click handler is delegated for the markdown's own controls: copy buttons and file links, which
         live inside v-html and so can hold no component of their own (see onMarkdownClick). -->
    <!-- A folded message (see `defers`) is a row like any other: no pin, and no inset of its own either, the
         column's gap is the air around every event in it, and .chat-prompt's band adds none on top of that
         (see chat.css). An acknowledgment keeps the prompt's alignment, because it is still the user talking;
         an errand is the app talking, so it sits at the left edge with the machinery. -->
    <!-- The blocks of one message stack on the transcript's own gap (.chat-stack, see --chat-gap): a turn's
         calls, its answer and the card it ends on are three events in the column, spaced like any other two. -->
    <div
        ref="row"
        class="chat-message chat-stack flex flex-col"
        :class="{
            'chat-prompt': message.role === 'user' && !defers,
            // The rows that host the pencil, which is the same set `items-end` names below: the user speaking,
            // in a bubble. It hangs in the gutter, OUTSIDE this row's box, and .chat-message paint-contains the
            // row — see .chat-gutter-host in chat.css for what that did to it.
            'chat-gutter-host': message.role === 'user' && errand === undefined,
            'items-end': message.role === 'user' && errand === undefined,
            'chat-prompt-open': expanded,
            'chat-prompt-pinned': pinned,
            'chat-doomed': doomed,
        }"
        @click="onMarkdownClick"
        @pointerdown="copyCodeFromEvent"
    >
        <!-- The errand row: one line naming what the app asked for, opening to the exact words it sent. -->
        <template v-if="errand">
            <button
                type="button"
                class="flex max-w-full items-center gap-2 self-start rounded-lg bg-overlay px-3 py-1.5 text-left text-2xs"
                :aria-expanded="errandOpen"
                @click="errandOpen = !errandOpen"
            >
                <Icon :name="errand.icon" class="shrink-0 text-2xs text-link" />
                <span class="shrink-0 font-medium text-content">{{ errand.label }}</span>
                <span class="truncate text-subtle">{{ errand.detail }}</span>
                <Icon :name="errandOpen ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs text-subtle" />
            </button>
            <div
                v-if="errandOpen"
                class="scrollbar-thin max-h-64 w-full overflow-auto whitespace-pre-wrap rounded-lg bg-overlay/60 px-3 py-2 text-xs leading-relaxed text-muted"
            >
                {{ message.text }}
            </div>
        </template>
        <div v-else-if="message.role === 'user'" class="group relative flex max-w-[85%] flex-col items-end gap-1.5">
            <!-- Stacked: a row of attachments above the prompt. The arrangement for a narrow panel, for edit
                 mode (a thumbnail beside the textarea would come out of the width of the narrowest thing in
                 the panel), and for every attachment set that can't go beside the bubble: see
                 attachmentsAside. It steps aside only where the copy below is actually shown. -->
            <ChatAttachmentStrip
                v-if="attachmentThumbs.length"
                :attachments="attachmentThumbs"
                class="flex-wrap justify-end"
                :class="attachmentsAside && '@lg:hidden'"
            />
            <div class="flex items-center gap-1">
                <!-- Aside: the same thumbnail to the LEFT of the prompt, taking over from the stacked row
                     above once the panel is wide enough (attachmentsAside settles everything except width).
                     A prompt is pinned for as long as its answer runs, so its height is charged against the
                     room that answer is read in: the six-line clamp on .chat-prompt-text is that budget:
                     and a 56px thumbnail row was 62px on top of it that nothing accounted for. Beside the
                     bubble the pair costs the TALLER of the two rather than their sum: measured, a screenshot
                     with a short prompt goes 121px -> 77px and one with a clamped prompt 218px -> 156px, on
                     the one row of the transcript that is never off screen.
                     Two elements rather than one moved by CSS, because the two arrangements do not share a
                     flex parent: reaching the stacked position from in here needs the row to wrap, and a
                     wrapping row drops the action buttons onto a line of their own as soon as the bubble
                     fills the width: 28px of dead height spent to save 62.
                     @lg is the floor at which the bubble still keeps a readable measure once the thumbnail
                     and the action gutter come out of 85% of the transcript width (47 characters there,
                     against 49 stacked one step narrower); at the docked default the same arrangement sets
                     the prompt to about twenty characters a line, so it stays stacked and the saving is
                     simply not available there. The query is on the transcript column (ChatPanel's
                     @container), so it answers to a dragged panel edge and to the floating window alike. -->
                <ChatAttachmentStrip v-if="attachmentsAside" :attachments="attachmentThumbs" class="mr-1 hidden shrink-0 self-start @lg:flex" />
                <!-- Frame and scroller are two elements, and `relative` belongs on the FRAME: past the cap the
                     text below scrolls, and the clamp fade and the open/close chip are positioned against this
                     box precisely so they don't scroll away with it. -->
                <div v-if="message.text" class="chat-surface relative rounded-lg" :class="{ 'chat-prompt-clamped': overflowing && !expanded }">
                    <div
                        ref="bubble"
                        class="chat-prompt-text scrollbar-thin whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-content"
                        :class="{ 'cursor-pointer': overflowing && !expanded }"
                        @scroll="onBubbleScroll"
                        @click="onBubbleClick"
                    >
                        {{ message.text }}
                    </div>
                    <!-- Only for a prompt the clamp actually cut. Opening does NOT unpin: wanting the whole
                         prompt while its answer streams beneath is exactly what the pin is for: past its cap
                         the open bubble scrolls internally instead of taking the panel over. -->
                    <button
                        v-if="overflowing"
                        type="button"
                        class="chat-prompt-toggle"
                        :aria-expanded="expanded"
                        :aria-label="expanded ? 'Collapse message' : 'Expand message'"
                        v-tooltip.left="expanded ? 'Show less' : 'Show more'"
                        @click="toggleExpanded"
                    >
                        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    </button>
                </div>
            </div>
            <!-- WHEN IT WAS SENT, in the MARGIN BESIDE the bubble and only while the pointer is on the message.
                 A transcript is read for what was said, so the hour it was said at is worth exactly the room it
                 takes when nobody is asking, which is none: the label is absolute, so it costs the row no
                 height either way. What the margin buys over the strip below the bubble (where this used to
                 hang) is that the label is INSIDE its own message's band. Under the bubble it sat in the gap
                 between two turns: the row's own bottom padding plus the gap between turns, which the meta tier
                 fills edge to edge, so it touched the bubble above and the answer below at once,
                 reading as plausibly a header for that answer as a footer for the prompt. And it landed in the
                 one corner of the bubble that already carries the clamp fade and the open/close chip.
                 The room is guaranteed, not hoped for: a prompt caps at 85% of the column, so the flank to its
                 left is never narrower than 15% of the reading measure, and the label is five characters wide
                 (see sentClock): it fits that flank at every panel width, with the column's own gutter behind
                 it for the tightest one. Right-aligned against the bubble so a run of stamps forms one edge
                 down the margin rather than ragging, and CENTRED on the message it belongs to: a stamp level
                 with the first line reads as a label attached to that line, and against a bubble six lines deep
                 it hangs off the top corner with the rest of the margin empty beneath it. Centred, it points at
                 the whole message, which is what it is the time of.
                 Centred by spanning the message's own height and aligning inside it (`inset-y-0` + a flex
                 centre) rather than by a half-height translate. The two land in the same pixel, but a transform
                 rasterises what it moves through a compositing step, and five characters at the meta tier are
                 exactly the ink that softens under one, and this way the rule states its intent (centre this on
                 the message) instead of half of a height the label does not own. It is measured against the
                 whole message, so a stacked attachment row counts toward the middle the same as the bubble does.
                 The span covers the flank's full height this way, which is dead space either way: it takes the
                 pointer for its tooltip and blocks nothing, unlike the old position under the bubble, which lay
                 over the strip a click uses to open a clamped prompt. -->
            <span
                v-if="sentClock"
                v-tooltip.top="sentExact"
                class="absolute inset-y-0 right-full mr-2 flex items-center text-2xs whitespace-nowrap tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100"
                >{{ sentClock }}</span
            >
            <!-- ASK THIS AGAIN, DIFFERENTLY: in the column's RIGHT margin, level with the prompt, which is the
                 same gutter the fork mark stands in at the other end of the turn (see ChatForkCut and the
                 EXCEPT-FOR note above). Real column, not negative space borrowed from the scroller, so it
                 cannot be clipped or push a horizontal scrollbar at any panel width.

                 EXACTLY the gutter wide and flush to the column's content edge, with no nudge of its own. A
                 prompt caps at 85% of the column and is right-aligned, so `left-full` IS that edge and the
                 gutter is the padding beyond it: one --chat-gutter of width drops the mark into precisely the
                 strip the fork mark stands in, and the pair measures to the same x. A margin on top of that:
                 even four pixels: spends room the column does not have and hangs the mark past the panel's own
                 edge, which is why the fork mark carries none either. It is also the boundary a hidden run's
                 count mark is positioned against — the gutter is the CONTROL lane, that pill takes the strip
                 past it (see .chat-run-mark in chat.css) — so a mark here that reached wider than the gutter
                 would be reaching into it.

                 It costs the row NO HEIGHT and no width: absolute, inside padding the column was already
                 carrying, opposite a clock in the left margin, so a prompt is exactly as tall with this control
                 as without it, which is the budget .chat-prompt-text's clamp is defending.

                 Pinned to the message's TOP rather than centred on it like the clock opposite, because the two
                 are answering different questions. The clock labels the whole message, so it points at the
                 middle of it; this acts on the message's first line: the words the reader is about to rewrite:
                 and against a six-line clamped prompt a centred pencil drifts into the middle of the margin with
                 nothing beside it to explain what it belongs to.

                 Revealed by hovering the MESSAGE (this bubble's own `group`), not the button, so there is
                 nothing to hunt for with the pointer; on touch there is no hover to reveal anything, so it
                 stands at low opacity the way the fork mark does there. -->
            <button
                v-if="editable"
                type="button"
                class="absolute top-0 left-full flex h-7 w-[var(--chat-gutter)] cursor-pointer items-center justify-center rounded-md text-subtle transition-opacity hover:bg-overlay hover:text-content"
                :class="mobile ? `opacity-40` : `opacity-0 focus-visible:opacity-100 group-hover:opacity-100`"
                v-tooltip.right="`Edit this message: replaces it and everything after`"
                aria-label="Edit this message"
                @click.stop="startEdit"
            >
                <Icon name="pencil" class="text-2xs" />
            </button>
        </div>
        <div
            v-else-if="message.role === 'notice' && message.text !== ''"
            class="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 self-center py-0.5 text-2xs text-subtle"
        >
            <!-- A notice whose wait is still running spins instead of showing the info glyph, and says how long
                 it has been waiting: the two things that tell "something is happening" from "this is stuck". It
                 settles back to the plain line the moment the wait ends (see ChatMessage.noticeWait). -->
            <Icon v-if="pendingWait" name="spinner" spin class="text-2xs text-info" />
            <Icon v-else name="info-circle" class="text-2xs" />
            <span>{{ message.text }}</span>
            <span v-if="pendingWait" class="shrink-0 tabular-nums">{{ formatElapsed(pendingWait.since, now) }}</span>
            <!-- The quiet follow-up some notices carry, see holdOffer. A link, not a button: the notice line
                 is the most muted thing in the transcript, and the offer must not outshout the turn it trails.
                 What the offer CHANGES trails it as a clause rather than hiding in a hover box: this is a
                 standing setting the click turns on, and a paragraph nobody hovers is not consent. The line
                 wraps, so the clause costs a second row at worst. -->
            <template v-if="holdOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="holdFutureLands">
                    Keep future work on the branch
                </button>
                <span class="shrink-0">(it waits as "Ready to land" until you land it)</span>
            </template>
            <template v-if="outageOptOutOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="stopResumingOutages">
                    Stop resuming this chat
                </button>
                <span class="shrink-0">(a turn the provider kills stops and waits for you)</span>
            </template>
            <template v-if="depsInstallOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="watchDepsInstall">Watch the install</button>
            </template>
            <template v-if="tierHoldOffer">
                <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="holdTier">Keep this chat on my pick</button>
                <span class="shrink-0">(later turns run the model you chose, even when they look simple)</span>
            </template>
        </div>
        <template v-else>
            <div v-if="message.thinking" class="w-full overflow-hidden rounded-lg border-l-2 border-line-strong bg-overlay/60">
                <button
                    type="button"
                    class="flex w-full items-center gap-1.5 px-2 py-1 text-2xs uppercase tracking-wide text-subtle"
                    @click="toggleThinking"
                >
                    <Icon class="text-2xs" :name="isThinkingOpen ? 'chevron-down' : 'chevron-right'" />
                    <span>Thinking</span>
                    <Icon name="spinner" v-if="streaming" class="text-2xs" spin />
                </button>
                <div
                    v-if="isThinkingOpen"
                    class="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2 text-xs leading-relaxed text-muted"
                >
                    {{ message.thinking }}
                </div>
            </div>

            <!-- `live` is this bubble's own stream flag, which is what "still happening" means for both of
                 these: a call in flight and the checklist the agent is moving both belong to the bubble the
                 turn is currently writing into. Anywhere else they are a record: frozen mid-flight by a Stop,
                 by the turn moving on, or by the session ending, and must not animate. -->
            <div v-if="message.tools?.length" class="flex w-full flex-col gap-1">
                <ChatToolRows v-if="showToolCalls" :tools="message.tools" :live="streaming" />
                <ChatToolRun v-else :tools="message.tools" :live="streaming" />
            </div>

            <ChatTodoList v-if="message.todos?.length" :todos="message.todos" :live="streaming" />

            <!-- The answer, as the parts the engine cut it into (see useMarkdown): prose runs, and the figures
                 an agent drew between them. Several v-html slots rather than one, and that is the streaming
                 property: a settled run is unchanged between frames, so Vue leaves its DOM (and the user's
                 selection) alone while only the short tail is re-rendered. `.md-part` is display:contents, so
                 the prose still lays out as direct children of .chat-markdown. -->
            <div v-if="message.text" class="md-prose chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5">
                <template v-for="(part, index) in body" :key="index">
                    <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                    <MarkdownFigure v-else :figure="part.figure" />
                </template>
            </div>
            <!-- The quiet mark on words the USER placed wearing the agent's voice (composer "as agent" mode).
                 Its one audience is the human re-reading this later: an unmarked planted line fools its own
                 author within a month. Deliberately outside the bubble and in the smallest muted tier: the row
                 must read as the agent's at a glance (that is the feature), and only confess on inspection.
                 The agent itself never sees the flag; the daemon's handoff renders placed rows as its own. -->
            <p
                v-if="message.placed"
                class="flex items-center gap-1 px-1 text-2xs text-subtle"
                v-tooltip.top="`You wrote this in the agent's voice: the agent reads it as its own words`"
            >
                <Icon name="pencil" class="text-2xs" />Placed by you
            </p>

            <!-- A NAME, not prose: the plan's own heading, which the body below opens with. -->
            <ChatCard
                v-if="message.plan"
                icon="list-check"
                icon-class="text-link"
                :title="planTitle(message.plan)"
                :status="planStatus(message.plan)"
            >
                <div class="md-prose chat-markdown chat-markdown-compact px-3.5 py-3">
                    <template v-for="(part, index) in plan" :key="index">
                        <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                        <MarkdownFigure v-else :figure="part.figure" />
                    </template>
                </div>
                <!-- THE PLAN THE TEXT ABOVE POINTS AT. Present only when the model wrote the real plan to a file
                     and summarised it in the adjacent prose (agent.ts decides, on which of the two is longer), so
                     approving is never a yes to a document the card did not show. -->
                <ChatDocumentBody
                    v-if="message.plan.document"
                    :document="message.plan.document"
                    foldable
                    :open="!documentDrawn(message.plan.document)"
                    max-height="22rem"
                    class="mx-3.5 mb-3"
                />
                <template v-if="message.plan.status === 'pending'" #actions>
                    <!-- One approval, not a posture menu: saying yes to a plan is saying yes to the work in it,
                         and the container is the isolation boundary. -->
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePlan(message, true)"
                        >Approve</ChatDecisionButton
                    >
                    <ChatDecisionButton tone="secondary" icon="pencil" :disabled="settling" @click="decidePlan(message, false)"
                        >No, keep planning</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- PROSE: the question wraps in full rather than truncating behind a tooltip, and a multi-question
                 card carries a generic title and breaks each question out inline in the body below. The tier
                 this card set is now the shell's `prose` mode; see ChatCard. -->
            <ChatCard
                v-if="message.question"
                icon="comments"
                icon-class="text-link"
                prose
                :title="message.question.questions.length > 1 ? 'A few questions' : (message.question.questions[0]?.question ?? '')"
                :status="questionStatus(message.question)"
            >
                <!-- WHAT THE QUESTION IS ABOUT, above the options and inside the same card: the write-up this
                     turn produced (agent.ts attaches it; the model is asked for nothing). A choice between
                     options describing a document is unanswerable without the document, and by the time the card
                     is raised that document is a folded card somewhere up the scroll. -->
                <ChatDocumentBody
                    v-if="message.question.document"
                    :document="message.question.document"
                    foldable
                    :open="!documentDrawn(message.question.document)"
                    max-height="22rem"
                    class="mx-3.5 mt-3"
                />
                <div class="flex flex-col gap-4 px-3.5 py-3">
                    <div v-for="(question, index) in message.question.questions" :key="index" class="flex flex-col gap-2">
                        <span v-if="message.question.questions.length > 1" class="chat-question-title text-xs font-medium text-content">{{
                            question.question
                        }}</span>

                        <div v-if="message.question.status === 'pending'" class="flex flex-col gap-1.5">
                            <!-- The one line that says out loud what the square marks below say by shape, and it
                                 is spent only on the multi-select case: a checkbox list that does not invite the
                                 second pick has wasted the affordance, whereas "Choose one" over round marks is
                                 a line every card would carry to tell the reader what they already assumed.
                                 Once picks exist it becomes the count, so the list keeps answering back. -->
                            <span v-if="question.multiSelect" class="text-2xs text-subtle">{{
                                pickedCount(index) > 0 ? `${pickedCount(index)} selected` : "Select all that apply"
                            }}</span>
                            <!-- Roles, not just paint: a radiogroup of radios and a group of checkboxes are how
                                 a screen reader is told the same thing the marks tell everyone else. The Other
                                 FIELD stays outside the group: it is the payload of the row above it, not
                                 another option to move a cursor onto. -->
                            <div class="flex flex-col gap-1.5" :role="question.multiSelect ? 'group' : 'radiogroup'" :aria-label="question.question">
                                <button
                                    v-for="option in question.options"
                                    :key="option.label"
                                    type="button"
                                    :role="question.multiSelect ? 'checkbox' : 'radio'"
                                    :aria-checked="isSelected(index, option.label)"
                                    class="ui-row-select flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left"
                                    :class="{ 'ui-row-select-on': isSelected(index, option.label) }"
                                    @click="toggleOption(question, index, option.label)"
                                >
                                    <Icon
                                        class="mt-0.5 text-2xs"
                                        :name="markFor(question, isSelected(index, option.label))"
                                        :class="isSelected(index, option.label) ? 'text-primary-500' : 'text-subtle'"
                                    />
                                    <!-- The description carries the actual trade-off between options, so it is muted
                                         rather than subtle: it is read before choosing, not glanced past. -->
                                    <span class="flex min-w-0 flex-col gap-0.5">
                                        <span class="text-xs font-medium text-content">{{ option.label }}</span>
                                        <span class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                        <!-- The preview is a MOCKUP: an ASCII layout, a diff, a config block:
                                             which the asking side writes precisely so the options can be compared
                                             side by side. It used to be piped into a tooltip: a 17rem strip, five
                                             lines at most, one option at a time, and gone the instant you moved
                                             toward the thing you were comparing it with. Preformatted and in the
                                             card, all of them are on screen at once, which is the whole point. -->
                                        <pre
                                            v-if="option.preview"
                                            class="scrollbar-thin mt-1 max-h-56 overflow-auto whitespace-pre rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[0.65rem] leading-snug text-muted"
                                            >{{ option.preview }}</pre>
                                    </span>
                                </button>
                                <!-- "Other" is the LAST OPTION, not a text box parked beside the list: same row,
                                     same mark, same click, and MARKUP IDENTICAL to the rows above: no wrapper of
                                     its own, or its border, hover and selected tint drift from the siblings it
                                     must read as one of. That sameness is what keeps this card's state a single
                                     list of picks: writing your own answer cannot contradict the options, because
                                     it is one of them, and it is why nothing here has to erase anything. The
                                     field appears BELOW the row on picking it, and keeps its text when the row is
                                     unpicked, so clicking away to re-read an option and clicking back costs
                                     nothing. -->
                                <button
                                    type="button"
                                    :role="question.multiSelect ? 'checkbox' : 'radio'"
                                    :aria-checked="isSelected(index, OTHER_LABEL)"
                                    class="ui-row-select flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left"
                                    :class="{ 'ui-row-select-on': isSelected(index, OTHER_LABEL) }"
                                    @click="toggleOption(question, index, OTHER_LABEL)"
                                >
                                    <Icon
                                        class="mt-0.5 text-2xs"
                                        :name="markFor(question, isSelected(index, OTHER_LABEL))"
                                        :class="isSelected(index, OTHER_LABEL) ? 'text-primary-500' : 'text-subtle'"
                                    />
                                    <span class="flex min-w-0 flex-col gap-0.5">
                                        <span class="text-xs font-medium text-content">Other</span>
                                        <span class="text-2xs leading-snug text-muted">{{
                                            question.multiSelect ? "Add an answer in your own words." : "Answer in your own words."
                                        }}</span>
                                    </span>
                                </button>
                            </div>
                            <div v-if="isSelected(index, OTHER_LABEL)" class="flex flex-col gap-1">
                                <!-- A TEXTAREA THAT GROWS, not a one-line input: the answers that go here are the
                                     ones no option covered, which is exactly the case that runs to a paragraph:
                                     and a field that scrolls its own start out of view while you write is a field
                                     you cannot re-read before submitting. It opens one row tall, so a short answer
                                     costs no more space than before. text-base below md: 16px is the iOS threshold
                                     under which focusing zooms the page. -->
                                <textarea
                                    :ref="(el) => setOtherInput(index, el)"
                                    rows="1"
                                    :value="otherValue(index)"
                                    @input="onOtherInput(index, $event)"
                                    @keydown="otherKeydown"
                                    placeholder="Type your answer…"
                                    class="scrollbar-thin max-h-48 resize-none overflow-y-auto rounded-lg border border-line bg-card px-2.5 py-1.5 text-base leading-relaxed text-content placeholder:text-subtle focus:border-line-strong focus:outline-none md:text-xs"
                                ></textarea>
                                <!-- Reads as the instruction it is, not as an error: it is on screen from
                                     the moment the row is picked, which is before there is anything to get
                                     wrong. It is also the only thing that explains the disabled Submit. -->
                                <span v-if="otherPending(index)" class="text-2xs text-subtle">Write your answer to submit.</span>
                            </div>
                        </div>
                        <!-- Decided (answered or dismissed): the same options, frozen. Nothing here may read as
                             a control: no button, no hover, no focus stop, and no empty radio, which is the
                             one mark that says "still yours to pick". Only the check moves. No preview either:
                             a mockup is an aid to CHOOSING, and once the choice is made, keeping every option's
                             block in the transcript would spend a screen on a question already answered. -->
                        <div v-else class="flex flex-col gap-1.5" role="list">
                            <div
                                v-for="option in decidedOptions(question)"
                                :key="option.label"
                                role="listitem"
                                class="flex items-start gap-2 rounded-lg border border-transparent px-2.5 py-2"
                                :class="{ 'chat-option-picked': option.picked }"
                            >
                                <span class="mt-0.5 flex w-3 shrink-0 justify-center">
                                    <Icon v-if="option.picked" name="check" class="text-2xs text-primary-500" />
                                </span>
                                <span class="flex min-w-0 flex-col gap-0.5">
                                    <span class="text-xs font-medium" :class="option.picked ? 'text-content' : 'text-muted'">
                                        <span v-if="option.picked" class="sr-only">Chosen: </span>{{ option.label }}
                                    </span>
                                    <!-- The rejected options keep the LIVE card's description colour: dimming
                                         the label is what says "not this one", and fading the reasoning under
                                         it past legibility would leave the alternatives on screen as texture
                                         rather than as the record they are here to be. (That colour is muted,
                                         not subtle: the live card moved with the type scale, and this rule is
                                         stated against it, so it moves too. Weight and gap match the live row
                                         for the same reason: answering a card must not reflow it.) -->
                                    <span v-if="option.description" class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- Moved into the shell's own answer row rather than sitting inside the options block, which
                     is where it used to be: every other card puts its answers behind the same rule, and a
                     Submit that floats under the last option reads as one more thing in the list. -->
                <template v-if="message.question.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="!canSubmit || settling" @click="submitAnswers"
                        >Submit</ChatDecisionButton
                    >
                    <!-- Dismissing ends the turn (see Conversation.cancelQuestion), which the label alone
                         does not say, so the tooltip does, before the click rather than after it. -->
                    <ChatDecisionButton
                        tone="secondary"
                        :disabled="settling"
                        v-tooltip.bottom="'Also stops the turn'"
                        @click="cancelQuestion(message)"
                        >Dismiss</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- PROSE, at last matching the comment this card has carried all along: permissionTitle is a full
                 sentence ("This command would read credential material"), so it wraps at the body tier rather
                 than truncating a size up. -->
            <ChatCard v-if="message.permission" icon="shield" prose :title="permissionTitle" :status="permissionStatus(message.permission)">
                <div class="flex flex-col gap-2 px-3.5 py-3">
                    <!-- THE SENTENCE FIRST when there is one (settings.explainCommands): what the program does
                         and what it is for, in the words the quick model wrote from the program text. It leads
                         because it is the thing that can be read in the two seconds this card gets, and it is
                         never the only account of the command, which sits under it either way. -->
                    <span v-if="message.permission.explain" class="text-xs leading-relaxed text-content/85">{{ message.permission.explain }}</span>
                    <span v-else-if="message.permission.description" class="text-xs text-content/85">{{ message.permission.description }}</span>

                    <template v-if="message.permission.program">
                        <!-- THE EVIDENCE, ALWAYS ON THE CARD. These are the fragments that put the command in
                             the class that held it, and they stay visible whether or not the command below is
                             folded away: hiding the command must never hide the reason it was stopped, or the
                             disclosure has traded a wall of shell for a card nobody can audit. Only shown
                             beside a sentence, though: with the command already expanded they would be the
                             same characters twice, marked in the same colour, one line apart. -->
                        <div v-if="message.permission.explain && commandFragments.length > 0" class="flex flex-wrap items-center gap-1.5">
                            <span class="text-2xs text-subtle">Stopped for</span>
                            <code
                                v-for="fragment in commandFragments"
                                :key="fragment"
                                class="chat-command-chip max-w-full truncate rounded px-1.5 py-0.5 font-mono text-2xs"
                                >{{ fragment }}</code
                            >
                        </div>

                        <!-- A DISCLOSURE, and deliberately neither a hover nor a tab.
                             Hover has no touch or keyboard equivalent, so putting the exact text of what you
                             are approving behind one hides it from every phone and every keyboard user. Tabs
                             would make the command a peer VIEW of its own summary, so reading the actual thing
                             costs a deliberate switch away from the card's default — on a safety prompt, the
                             default has to be the thing itself or one labelled click from it.
                             Only offered when a sentence stands in for it; with no sentence there is nothing
                             to collapse behind and the command is simply the body. -->
                        <button
                            v-if="message.permission.explain"
                            type="button"
                            :class="ui.textAction(`gap-1 text-2xs`)"
                            :aria-expanded="commandOpen"
                            @click="commandOpen = !commandOpen"
                        >
                            <Icon :name="commandOpen ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                            {{ commandOpen ? "Hide the command" : "Show the command" }}
                        </button>
                        <ChatCommandBlock v-if="commandOpen || !message.permission.explain" :program="message.permission.program" />
                    </template>

                    <span v-if="message.permission.path" class="font-mono text-2xs text-subtle">{{ message.permission.path }}</span>
                    <span v-if="message.permission.reason" class="text-2xs text-subtle">Requested because: {{ message.permission.reason }}</span>
                </div>

                <template v-if="message.permission.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePermission(message, 'once')"
                        >Allow once</ChatDecisionButton
                    >
                    <!-- An approval in the secondary tone: the card is asking for the one-off allow, and a second
                         filled button beside it would make the pair read as a coin flip (see ChatDecisionButton). -->
                    <ChatDecisionButton
                        v-if="message.permission.alwaysLabel"
                        tone="secondary"
                        icon="lock"
                        :disabled="settling"
                        @click="decidePermission(message, 'always')"
                        >{{ message.permission.alwaysLabel }}</ChatDecisionButton
                    >
                    <!-- Same as the question card's Dismiss: a refusal with nothing to redirect the agent to
                         ends the turn rather than leaving it to work around the answer it was just given. -->
                    <ChatDecisionButton
                        tone="secondary"
                        icon="times"
                        :disabled="settling"
                        v-tooltip.bottom="'Also stops the turn'"
                        @click="decidePermission(message, 'deny')"
                        >No</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- The agent's browser needs a person: a captcha, a sign-in step it cannot clear. The primary
                 action NAVIGATES rather than decides: the live stage, Take control and "hand back" are all on
                 /browsers, so the card resolves from over there (the resolved frame freezes it here). Chat
                 offers only the answer that needs no browser: can't help now. -->
            <ChatCard
                v-if="message.browserHelp"
                icon="desktop"
                icon-class="text-warning"
                :title="`The agent's browser needs you: ${message.browserHelp.account}`"
                :status="helpStatus(message.browserHelp)"
            >
                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span class="text-xs text-content/85">{{ message.browserHelp.message }}</span>
                </div>

                <template v-if="message.browserHelp.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="desktop" :to="helpBrowserAt(message.browserHelp.session)"
                        >Open the browser</ChatDecisionButton
                    >
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="declineBrowserHelp(message)"
                        >Can't help now</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- The agent's terminal needs a person: a command it started is sitting at a prompt it cannot
                 answer. The browser card's twin, and deliberately identical in shape: the primary action
                 NAVIGATES (opens the terminal panel on that session, where the live prompt and "hand back"
                 are), and chat offers only the answer that needs no terminal. -->
            <ChatCard
                v-if="message.terminalHelp"
                icon="terminal"
                icon-class="text-warning"
                title="The agent's terminal needs you"
                :status="helpStatus(message.terminalHelp)"
            >
                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span class="text-xs text-content/85">{{ message.terminalHelp.message }}</span>
                </div>

                <template v-if="message.terminalHelp.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="terminal" @click="openHelpTerminal(message.terminalHelp)"
                        >Open the terminal</ChatDecisionButton
                    >
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="declineTerminalHelp(message)"
                        >Can't help now</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- A priced service run asking for the owner's click: the product's spend gate. Every number on
                 it is the platform's (relayed through the daemon's offer card, never typed by the model); the
                 agent's own words are the one `why` line. The click here is the ONLY way the run can happen:
                 the agent's command sits parked on the daemon until this card settles it. -->
            <ChatCard
                v-if="message.serviceOffer"
                icon="star"
                :title="`Run ${message.serviceOffer.offer.name}?`"
                :status="offerStatus(message.serviceOffer)"
            >
                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span class="text-xs text-content/85">{{ message.serviceOffer.offer.description }}</span>
                    <span class="font-mono text-2xs text-subtle"
                        >{{ message.serviceOffer.offer.slug }} · by {{ message.serviceOffer.offer.publisher }}</span
                    >
                    <span v-if="message.serviceOffer.offer.why" class="text-2xs text-subtle"
                        >The agent's case: {{ message.serviceOffer.offer.why }}</span
                    >
                    <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="message.serviceOffer.offer.request"
                        >Request: {{ message.serviceOffer.offer.request }}</span
                    >
                    <span class="pt-1 font-mono text-xs text-content">
                        {{ formatCredits(message.serviceOffer.offer.creditsPerRun) }} credits per run<template
                            v-if="message.serviceOffer.offer.credits"
                        >
                            · {{ formatCredits(message.serviceOffer.offer.credits.remaining) }} of
                            {{ formatCredits(message.serviceOffer.offer.credits.allowance) }} left today</template
                        >
                    </span>
                </div>

                <!-- The run living: the provider's own status line, streamed through the platform while the
                     answer is composed: the paid seconds visible instead of a spinner of unknowable length. -->
                <div v-if="serviceStatus" class="chat-card-row flex items-center gap-2 px-3.5 py-2.5">
                    <Icon name="spinner" class="text-2xs text-link" spin />
                    <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ serviceStatus }}</span>
                </div>

                <!-- The receipt, from the platform's own answer: what a served run cost and what is left, or the
                     two ways it ended free: a refunded no-answer, a refusal that raced the allowance. -->
                <div v-if="message.serviceOffer.receipt" class="chat-card-row px-3.5 py-2.5">
                    <span v-if="message.serviceOffer.receipt.outcome === 'ok'" class="font-mono text-2xs text-muted"
                        >Served · {{ formatCredits(message.serviceOffer.receipt.credits) }} credits<template
                            v-if="message.serviceOffer.receipt.remaining !== undefined"
                        >
                            · {{ formatCredits(message.serviceOffer.receipt.remaining) }} left today</template
                        ></span
                    >
                    <span v-else-if="message.serviceOffer.receipt.outcome === 'refunded'" class="text-2xs text-muted"
                        >The service didn't answer: refunded, nothing charged.</span
                    >
                    <span v-else class="text-2xs text-muted">The platform refused the run after all: nothing charged.</span>
                </div>

                <template v-if="message.serviceOffer.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decideServiceOffer(message, true)"
                        >Run: {{ formatCredits(message.serviceOffer.offer.creditsPerRun) }} credits</ChatDecisionButton
                    >
                    <!-- Free and final: the agent is told to continue without it; nothing stops the turn. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decideServiceOffer(message, false)"
                        >Skip: free</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- A USDC payment asking for the owner's click: the wallet's spend gate. Every number on it is
                 the daemon's arithmetic over the ENDPOINT's own 402 challenge and the wallet's ledger, never
                 typed by the model; the agent's own words are the one `why` line. The click here is the ONLY
                 way the money can move: the agent's command sits parked on the daemon until this card settles
                 it, and the signature is minted off-box by the platform only after it does. -->
            <ChatCard
                v-if="message.paymentOffer"
                icon="credit-card"
                :title="`Pay $${message.paymentOffer.offer.amountUsd} ${message.paymentOffer.offer.assetName}?`"
                :status="offerStatus(message.paymentOffer)"
            >
                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span v-if="message.paymentOffer.offer.description" class="text-xs text-content/85">{{
                        message.paymentOffer.offer.description
                    }}</span>
                    <!-- The URL in full on hover: which endpoint is being paid is the fact this card exists to
                         put in front of the owner, and a truncated host is exactly how a lookalike gets paid. -->
                    <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="message.paymentOffer.offer.url">{{
                        message.paymentOffer.offer.url
                    }}</span>
                    <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="message.paymentOffer.offer.payTo"
                        >To {{ message.paymentOffer.offer.payTo }}</span
                    >
                    <span v-if="message.paymentOffer.offer.why" class="text-2xs text-subtle"
                        >The agent's case: {{ message.paymentOffer.offer.why }}</span
                    >
                    <span class="pt-1 font-mono text-xs text-content">
                        ${{ message.paymentOffer.offer.amountUsd }} · ${{ message.paymentOffer.offer.spentTodayUsd }} of ${{
                            message.paymentOffer.offer.dailyCapUsd
                        }}
                        spent today
                    </span>
                </div>

                <!-- The receipt, from the endpoint's own settlement answer: what was paid and the onchain
                     transaction, or the one honest failure: a payment that never settled spends nothing,
                     because the signed authorization simply expires. -->
                <div v-if="message.paymentOffer.receipt" class="chat-card-row px-3.5 py-2.5">
                    <span v-if="message.paymentOffer.receipt.outcome === 'paid'" class="truncate font-mono text-2xs text-muted"
                        >Paid ${{ message.paymentOffer.receipt.amountUsd
                        }}<template v-if="message.paymentOffer.receipt.transaction"> · {{ message.paymentOffer.receipt.transaction }}</template></span
                    >
                    <span v-else class="text-2xs text-muted">The payment didn't go through: nothing was spent.</span>
                </div>

                <template v-if="message.paymentOffer.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePaymentOffer(message, true)"
                        >Pay ${{ message.paymentOffer.offer.amountUsd }}</ChatDecisionButton
                    >
                    <!-- Free and final: the agent is told to continue without it; nothing stops the turn. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decidePaymentOffer(message, false)"
                        >Skip: free</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- A missing capability asking for the owner's setup: the product's setup gate. The title and the
                 card id are the catalog's own words (resolved by the daemon that validated the ask, never typed
                 by the model); the agent's own words are the one `why` line. Connect is a decision AND a
                 navigation: setup happens on the Capabilities page, and the agent stays parked until the
                 connection comes live: the outcome row below is what says how that wait ended. -->
            <ChatCard
                v-if="message.capabilityOffer"
                icon="bolt"
                :title="`${message.capabilityOffer.offer.name} isn't connected yet`"
                :status="capabilityStatus(message.capabilityOffer)"
            >
                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span v-if="capabilityDescription" class="text-xs text-content/85">{{ capabilityDescription }}</span>
                    <span v-if="message.capabilityOffer.offer.why" class="text-2xs text-subtle"
                        >The agent's case: {{ message.capabilityOffer.offer.why }}</span
                    >
                </div>

                <!-- The wait living: the owner said yes and the agent is parked on the setup, with the way back
                     to it for whoever closed the page mid-flow. Settles via the outcome frame. -->
                <div
                    v-if="message.capabilityOffer.status === 'connecting' && !message.capabilityOffer.outcome"
                    class="chat-card-row flex items-center gap-2 px-3.5 py-2.5"
                >
                    <Icon name="spinner" class="text-2xs text-link" spin />
                    <span class="min-w-0 flex-1 truncate text-2xs text-muted">Waiting for you to finish setup…</span>
                    <ChatDecisionButton tone="secondary" icon="bolt" :to="capabilitySetupAt(message.capabilityOffer.offer.card)"
                        >Open setup</ChatDecisionButton
                    >
                </div>

                <!-- How an accepted ask ended: the agent's side of it, so the row reads as what happened next. -->
                <div v-if="message.capabilityOffer.outcome" class="chat-card-row px-3.5 py-2.5">
                    <span v-if="message.capabilityOffer.outcome.outcome === 'connected'" class="text-2xs text-muted"
                        >Connected<template v-if="message.capabilityOffer.outcome.id"> as "{{ message.capabilityOffer.outcome.id }}"</template>: the
                        agent is continuing with it.</span
                    >
                    <span v-else class="text-2xs text-muted">The setup didn't finish while the agent waited: it continued without it.</span>
                </div>

                <template v-if="message.capabilityOffer.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="connectCapability(message)"
                        >Connect {{ message.capabilityOffer.offer.name }}</ChatDecisionButton
                    >
                    <!-- Final for this conversation: the agent is told to continue without it and not to ask
                         again; nothing stops the turn. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decideCapabilityOffer(message, false)"
                        >Not now</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- The loader is a status line, not a message: it sits at the meta tier with the tool cards it
                 trails, and takes the assistant bubble's padding so the stack keeps one left edge. -->
            <div v-if="showTyping" class="flex items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
                <Icon name="spinner" class="text-2xs text-link" spin />
                <span v-if="providerRetry"
                    >The model provider is {{ retryReason }}: {{ retryWait }}
                    <span class="text-subtle">(attempt {{ providerRetry.attempt }}, nothing lost)</span></span
                >
                <span v-else
                    >{{ loaderWord }}… <span v-if="loaderElapsed" class="text-subtle">({{ loaderElapsed }})</span></span
                >
            </div>
        </template>

        <!-- What this turn has been kept going by since it was asked (see `trailer`). Outside the branches
             above because it belongs to the turn's OPENER whatever that opener turned out to be: a prompt, an
             errand, or the assistant text a restored history opens on, and it inherits the row's alignment,
             so it reads under the bubble it qualifies on either side. -->
        <span v-if="trailer" class="text-2xs text-subtle"
            >↳ {{ trailer.label }}<template v-if="trailer.count > 1"> ×{{ trailer.count }}</template></span
        >

        <!-- WHAT THE DAEMON ADDED TO WHAT THE AGENT READ (see `notesOpen`): one line naming each note, opening
             to exactly the words it was given. Outside the branches above because it hangs off the user's own
             message rather than replacing it. Full width and left-aligned even under a user bubble: this is
             machine prose to be read, not something they said.
             Open, it is capped and scrolls, for the reason .chat-prompt-open caps the bubble's own expansion at
             45dvh: on a user message this row IS the sticky pinned prompt, so an unbounded panel would take the
             panel over for as long as the turn runs. -->
        <template v-if="message.notes?.length">
            <button
                type="button"
                class="flex max-w-full items-center gap-2 self-start rounded-lg bg-overlay px-3 py-1.5 text-left text-2xs"
                :aria-expanded="notesOpen"
                @click="notesOpen = !notesOpen"
            >
                <Icon name="info-circle" class="shrink-0 text-2xs text-link" />
                <span class="shrink-0 font-medium text-content">Sent with your message</span>
                <span class="truncate text-subtle">{{ noteTitles }}</span>
                <Icon :name="notesOpen ? 'chevron-up' : 'chevron-down'" class="shrink-0 text-2xs text-subtle" />
            </button>
            <div v-if="notesOpen" class="scrollbar-thin flex max-h-80 w-full flex-col gap-3 overflow-auto rounded-lg bg-overlay/60 px-3 py-2">
                <div v-for="note in message.notes" :key="note.title" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ note.title }}</span>
                    <span class="whitespace-pre-wrap text-xs leading-relaxed text-muted">{{ noteBody(note.text) }}</span>
                </div>
            </div>
        </template>
    </div>
</template>
