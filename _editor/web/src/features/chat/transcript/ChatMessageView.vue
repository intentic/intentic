<script setup lang="ts">
import { type IconName, growTextarea, MarkdownFigure, useDevice, ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock, formatDateTime } from "@intentic/ui/format";
import { copyCodeFromEvent } from "@intentic/ui/markdown";
import { basename } from "@intentic/ui/path";
import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { type AskQuestion, type CardDocument, planParts, type TranscriptPlan, type TranscriptTerminalHelp } from "@intentic/sandbox-contract";
import { type ComponentPublicInstance, computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useQueryClient } from "@tanstack/vue-query";
import { attachmentPreview } from "../drafts/attachmentPreviews";
import { clearQuestionDraft, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "../drafts/questionDraft";
import { effectiveAutoLand, effectiveOutageResume, formatElapsed } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { errandOf } from "../run/errands";
import { personaRouteWait } from "../personas/personaRoute";
import { type ChatMessage, foldsIntoTurn } from "./transcript";
import { navigateInApp } from "../../../shell/window/mainWindow";
import { useMarkdown } from "../../../lib/markdown/useMarkdown";
import { openFileRefFromEvent } from "../../workspace/files/openFileRef";
import { invalidateWorkspace } from "../../workspace/changes/useHistory";
import { usePaneView } from "../panel/useChat-view";
import { landsByDefault } from "../../sandbox/environment/rules";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { openWorkTerminal, useWorkTerminals } from "../../terminal/useWorkTerminals";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";
import { useSandboxSession } from "../../sandbox/client/sandboxSession";
import { useToolCalls } from "../tools/useToolCalls";
import ChatAttachmentStrip from "../composer/ChatAttachmentStrip.vue";
import ChatCard from "./ChatCard.vue";
import ChatCommandBlock from "../tools/ChatCommandBlock.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import ChatDocumentBody from "./ChatDocumentBody.vue";
import { capabilityStatus, credentialLane, helpStatus, offerStatus, permissionStatus, planStatus, questionStatus } from "./cardStatus";
import ChatFold from "./ChatFold.vue";
import ChatThinking from "./ChatThinking.vue";
import ChatTodoList from "./ChatTodoList.vue";
import ChatToolRows from "../tools/ChatToolRows.vue";
import ChatToolRun from "../tools/ChatToolRun.vue";
import ChatTurnStatus from "./ChatTurnStatus.vue";
import { present } from "../tools/toolPresentation";

// Renders one transcript entry (user bubble, notice line, or assistant turn stack). Card decisions go through the
// useChat singleton; per-message UI state lives here.

const props = defineProps<{
    message: ChatMessage;
    streaming: boolean;
    // Messages folded into this turn (continue-nudges, errands), set only on the opening message (ChatTurn.folded).
    folded?: readonly ChatMessage[];
    // Row would be discarded by the pending edit (ChatPane's `doomed`); a preview only, not an actual state change.
    doomed?: boolean;
}>();

const {
    conversation,
    decidePlan,
    answerQuestion,
    cancelQuestion,
    decidePermission,
    decideCapabilityOffer,
    decidePaymentOffer,
    decideCredentialOffer,
    declineBrowserHelp,
    declineTerminalHelp,
    awaitingDecision,
    isDeciding,
    editing,
    beginEdit,
    streaming: conversationStreaming,
} = usePaneView();

// Browser-help's primary action links to /browsers (ChatDecisionButton's `to`) rather than deciding in place.
// Gates a card's other buttons while one answer is in flight; the pressed button already holds itself (kit's Button).
const settling = computed(() => isDeciding(props.message));

// Whether the viewer is a release card's named approver; a courtesy only — the daemon verifies identity server-side.
// Case-insensitive; no presented email leaves the buttons enabled.
const { presentedEmail } = useSandboxSession();
const mayRelease = computed(() => {
    const approvers = props.message.credentialOffer?.offer.approvers;
    const me = presentedEmail.value?.toLowerCase();
    return approvers === undefined || me === undefined || approvers.some((approver) => approver.toLowerCase() === me);
});

const router = useRouter();
const helpBrowserAt = (session: string): string => `/browsers/${session}`;

// Opens the terminal-help card's target: a panel, not a route, focused on the agent's session.
const openHelpTerminal = (help: TranscriptTerminalHelp): void =>
    useTerminalPanel().openFocused(help.session, { title: `The agent needs you at this terminal`, detail: help.message });

// Connect is both a decision (un-parks the daemon) and a navigation to the Capabilities page, opened to this card.
const capabilitySetupAt = (card: string): string => `/capabilities/${card}`;
const connectCapability = async (message: ChatMessage): Promise<void> => {
    // Awaits the decision so the button holds; the navigation is fire-and-forget.
    navigateInApp(router, capabilitySetupAt(message.capabilityOffer?.offer.card ?? ``));
    await decideCapabilityOffer(message, true);
};

// Catalog description, when the static catalog knows the card; absent for a contributed card.
const capabilityDescription = computed(() => {
    const card = props.message.capabilityOffer?.offer.card;
    return card === undefined ? undefined : CAPABILITY_CATALOG.find((entry) => entry.id === card)?.description;
});
const { mobile } = useDevice();

// landHold's one-press opt-out from future auto-land, scoped per-agent and gated on the current effective posture.
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

// Outage opt-out, same pattern as landHold; sets `false` rather than null so it can't fall back to a resuming default.
const outageOptOutOffer = computed(
    () =>
        props.message.noticeAction === `outageOptOut` &&
        effectiveOutageResume(agentById(conversation.value.conversationId), sandboxSettings.value?.resumeAfterOutage),
);
const stopResumingOutages = async (): Promise<void> => {
    await setResumeAfterOutage(conversation.value.conversationId, false).catch(() => undefined);
};

// Reveals the terminal for a daemon-started dependency install; gated on the install still running.
const { rows: liveWork } = useWorkTerminals();
// Install panel jobs are keyed `<project>--install` (workspace-setup.ts installPanelKey); matched here by suffix.
const installSession = computed(() => liveWork.value.find((row) => row.session.endsWith(`--install`))?.session);
const depsInstallOffer = computed(() => props.message.noticeAction === `depsInstall` && installSession.value !== undefined);
const watchDepsInstall = (): void => {
    if (installSession.value !== undefined) {
        openWorkTerminal(installSession.value);
    }
};

// One-press opt-out from automatic tier routing; flips the conversation's own tierHold flag, not the sandbox setting.
const tierHoldOffer = computed(() => props.message.noticeAction === `tierHold` && !conversation.value.tierHold.value);
const holdTier = (): void => {
    conversation.value.setTierHold(true);
};

// Both prose surfaces share one composable (useMarkdown); one renderer per message, held for the component's life.
// Workspace scope for file links: an isolated conversation's own checkout, undefined (= /work) for a shared one.
const linkAgent = computed(() => (conversation.value.isolated.value ? conversation.value.conversationId : undefined));

const body = useMarkdown(
    () => props.message.text,
    () => props.streaming,
    linkAgent,
);
// A plan card's body arrives whole with the card, so it never streams.
const plan = useMarkdown(() => (props.message.plan ? planParts(props.message.plan.text).body : ``), false, linkAgent);

const planTitle = (request: TranscriptPlan): string => planParts(request.text).title ?? `Proposed plan`;

// Whether the document's title differs enough from the card's own to need its own name row.
const documentTitled = (cardTitle: string, carried: CardDocument): boolean => carried.title.trim() !== cardTitle.trim();

// Whether a bubble already renders a card's document (as the Write that produced it); the card then opens folded.
const documentDrawn = (document: CardDocument | undefined): boolean =>
    // Checked via the tool's own presenter, not the shared rule, so a failed write can't fold the card away.
    document !== undefined && (props.message.tools ?? []).some((tool) => present(tool).document?.path === document.path);

// Delegated listener for markdown's copy buttons and file links (inside v-html); bound to press, since a live rerender
// can destroy the button before click fires.
const onMarkdownClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    openFileRefFromEvent(event);
};

// Permission card header: bridge's rendered prompt sentence, else short noun phrase, else bare tool name.
const permissionTitle = computed(() => {
    const permission = props.message.permission;
    if (permission === undefined) {
        return ``;
    }
    return permission.title ?? permission.displayName ?? permission.toolName;
});

// Command disclosure, closed by default, per-decision only: the card's title already states the safety judgment.
const commandOpen = ref(false);

// Status line shows for the whole live turn, not just before the first token, since the model can go quiet
// mid-tool-call. Reads the conversation's streaming flag, not this message's.
const showTyping = computed(() => props.streaming && !awaitingDecision.value);

// Wait shown by this notice while running (ChatMessage.noticeWait); undefined once it ends. Each kind is asked of
// whoever owns that wait, since none of them is a field on the row.
const pendingWait = computed(() => {
    switch (props.message.noticeWait) {
        case `credentialRenewal`:
            return conversation.value.failures.credentialRenewal.value;
        case `personaRoute`:
            return personaRouteWait(conversation.value);
        default:
            return undefined;
    }
});

// Clock for a pending notice wait only; stops once the wait ends.
const now = useNow(() => pendingWait.value !== undefined);

// Question card state, keyed by index, mirrored to localStorage per requestId (questionDraft). "Other" is a normal
// option, not parallel state.
const selections = ref<Record<number, string[]>>({});
const otherTexts = ref<Record<number, string>>({});
// One free-text field per row, indexed so picking a row can focus its caret.
const otherInputs = ref<Record<number, HTMLTextAreaElement | undefined>>({});
// Manual textarea auto-grow, as in the composer: reset to one line, then grow to content.
const growOther = (el: HTMLTextAreaElement | undefined): void => {
    growTextarea(el, 192);
};
// Also grows on attach, not just input, since a restored draft can arrive with text already in it.
const setOtherInput = (index: number, el: Element | ComponentPublicInstance | null): void => {
    const field = el instanceof HTMLTextAreaElement ? el : undefined;
    otherInputs.value[index] = field;
    void nextTick(() => growOther(field));
};

// Loads the draft when a pending card appears; clears it once the card settles (answered, dismissed, cancelled).
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
        // Normalizes the stored draft to picks the current card accepts (questionDraft.normalize).
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

// Toggles a pick for any row including Other: single-select replaces, multi-select accumulates, re-click clears.
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
    // Focuses the Other field once it renders.
    if (label === OTHER_LABEL && next.includes(OTHER_LABEL)) {
        void nextTick(() => otherInputs.value[index]?.focus());
    }
};

// Marker icon: square/checkbox for multi-select, circle/radio for single-select; shape, text, and ARIA role agree.
const markFor = (question: AskQuestion, selected: boolean): IconName => {
    if (question.multiSelect) {
        return selected ? `check-square` : `square`;
    }
    return selected ? `check-circle` : `circle`;
};

// Backs the multi-select hint's running count.
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

// Other picked but blank counts as unfinished, blocking Submit rather than being dropped silently.
const otherPending = (index: number): boolean => isSelected(index, OTHER_LABEL) && otherValue(index).trim().length === 0;

// Resolves picks to answer values, swapping the Other sentinel for its typed text.
const picksFor = (index: number): string[] =>
    (selections.value[index] ?? []).flatMap((label) => {
        if (label !== OTHER_LABEL) {
            return [label];
        }
        const typed = otherValue(index).trim();
        return typed.length > 0 ? [typed] : [];
    });

const canSubmit = computed(() => props.message.question?.questions.every((_, index) => picksFor(index).length > 0 && !otherPending(index)) ?? false);

// Returns the promise so Submit stays disabled until the answer settles.
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

// Enter submits, Shift+Enter breaks the line; mobile Enter always inserts a newline.
const otherKeydown = (event: KeyboardEvent): void => {
    if (event.key !== `Enter` || event.isComposing || event.shiftKey || mobile.value) {
        return;
    }
    event.preventDefault();
    submitAnswers();
};

// A decided question keeps every option, marking which were picked; a typed answer joins as an option-less row.
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

// Edit pencil shows only for a user prompt with a rewindIndex, never mid-turn (agent/rewind.ts), and never while this
// message's own edit is open.
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

// Clamp overflow (.chat-prompt-text) depends on wrap width, so it's measured via ResizeObserver, not guessed from text.
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
            // Skip measuring while expanded, since the box always fits and remeasuring would clear the collapse flag.
            if (!expanded.value) {
                overflowing.value = element.scrollHeight > element.clientHeight + 1;
            }
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { immediate: true, flush: `post` },
);

// Folded messages never pin, since sticking one would cover the prompt it defers to.
const defers = computed(() => foldsIntoTurn(props.message));

// An errand is a prompt the app sent on the user's behalf (errands.ts); shown as a label, exact text one click away.
const errand = computed(() => errandOf(props.message));

// Notes the daemon prepended to the user's text (rebase, stale deps, retrieved context); named on the shut fold, so the
// body never repeats them.
const noteTitles = computed(() => (props.message.notes ?? []).map((note) => note.title).join(`, `));

// Strips a leading markdown heading (first line only); the row's own label already names the note.
const noteBody = (text: string): string => text.replace(/^#{1,6} .*(\n|$)/, ``).trim();

// Trailer naming the latest thing keeping this turn going, and how many said the same; shown in-flow so it can't shift
// the pinned row's height.
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

// Pinned state (.chat-prompt-pinned).
// Whether the prompt is actually stuck (CSS can't ask): compares the row's top to the scroller's edge on scroll and on
// either box resizing; the IntersectionObserver only toggles that listener.
const row = ref<HTMLElement>();
const pinned = ref(false);

watch(
    row,
    (element, _previous, onCleanup) => {
        pinned.value = false;
        if (element === undefined || props.message.role !== `user` || defers.value) {
            return;
        }
        // The row's only valid pin anchor is `.chat-scroller`.
        const scroller = element.closest(`.chat-scroller`);
        if (scroller === null) {
            return;
        }
        // Compares against the midpoint of the row's 1px sticky offset, robust to fractional scroll position or display
        // scaling.
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
        // Gates the scroll listener on visibility so off-screen rows aren't measured.
        const observer = new IntersectionObserver(
            (entries) => {
                listen(entries.at(-1)?.isIntersecting === true);
                sync();
            },
            { root: scroller },
        );
        observer.observe(element);
        // A row crosses the threshold with nothing scrolled, too: content above it changes height (a card folding,
        // the warm-up pass giving skipped rows their real heights) or the box around it resizes (the floating
        // window fitting itself around a second pane). Scroll anchoring hides most of that — it moves scrollTop to
        // hold the reader's place, and Chromium does fire a scroll event when it does — but it is suppressed on any
        // frame that changes a computed style on the anchor's ancestors, which is what folding a row IS. The row
        // then lifts with no scroll event behind it, and the prompt keeps a transparent band while the turn scrolls
        // through it, until the reader happens to scroll: the report this measurement was added for.
        // Two boxes, for the reason useStickToBottom watches two: the scroller's own box changes when the pane or
        // window resizes it, the wrapper inside it (ChatPane's `content`, which the transcript's insets live on)
        // changes when the turn grows, and neither implies the other.
        const resizer = new ResizeObserver(() => {
            if (listening) {
                sync();
            }
        });
        resizer.observe(scroller);
        // Guarded, not asserted: a scroller with nothing in it yet is a transcript with no row to pin either.
        if (scroller.firstElementChild !== null) {
            resizer.observe(scroller.firstElementChild);
        }
        // Syncs and listens immediately, so an already-stuck row (transcript restored at the bottom) starts out pinned.
        sync();
        listen(true);
        onCleanup(() => {
            observer.disconnect();
            resizer.disconnect();
            listen(false);
        });
    },
    { immediate: true, flush: `post` },
);

// A clamped box has no scrollbar, so any scroll event means find-in-page or a screen reader jumped inside it: expand
// and reset scroll. An open box is left alone.
const onBubbleScroll = (): void => {
    if (expanded.value) {
        return;
    }
    if (bubble.value !== undefined && bubble.value.scrollTop > 0) {
        expanded.value = true;
        bubble.value.scrollTop = 0;
    }
};

// Clicking a clamped bubble expands it, one direction only; guarded on an active selection so dragging text doesn't
// trigger it.
const onBubbleClick = (): void => {
    // Reads the bubble's own window's selection, since a popped-out window has its own.
    const selection = bubble.value?.ownerDocument.defaultView?.getSelection() ?? window.getSelection();
    if (expanded.value || !overflowing.value || selection?.isCollapsed === false) {
        return;
    }
    expanded.value = true;
};

const toggleExpanded = (): void => {
    expanded.value = !expanded.value;
    // Reset scroll before the clamp reapplies, or the leftover offset re-triggers onBubbleScroll's find-in-page
    // detection.
    if (!expanded.value && bubble.value !== undefined) {
        bubble.value.scrollTop = 0;
    }
};

// Resolves thumbnails by path: an object URL minted here if staged locally, else re-minted from workspace bytes.
const attachmentThumbs = computed(() =>
    (props.message.attachments ?? []).map((path) => ({
        name: basename(path),
        path,
        previewUrl: attachmentPreview(path),
    })),
);

// Whether a single image attachment may sit beside the prompt instead of stacking above it (width is handled separately
// by the @lg container query):
// - exactly one attachment, since beside costs only the taller of the two
// - an image, since anything else is a filename chip that needs its own width
// - a prompt to align against
const attachmentsAside = computed(
    () => props.message.text.length > 0 && attachmentThumbs.value.length === 1 && attachmentThumbs.value[0]?.previewUrl !== undefined,
);

// Absolute wall-clock minute label ("14:32"); day is omitted since ChatPane's day markers already show it (full
// date/time in the tooltip). Undefined with no sentAt.
const sentClock = computed(() => (props.message.sentAt === undefined ? undefined : formatClock(props.message.sentAt)));
const sentExact = computed(() => (props.message.sentAt === undefined ? undefined : formatDateTime(props.message.sentAt)));
</script>

<template>
    <!-- Delegated markdown controls (copy buttons, file links), since both live inside v-html. -->
    <!--
        A folded message renders like any other row: no pin, no extra inset. An acknowledgment keeps the user's alignment; an errand sits left with
        the machinery.
    -->
    <!-- Blocks within a message share the transcript's own gap (.chat-stack, --chat-gap). -->
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
        <ChatFold v-if="errand" :icon="errand.icon" :label="errand.label" :detail="errand.detail">
            <p class="whitespace-pre-wrap">{{ message.text }}</p>
        </ChatFold>
        <div v-else-if="message.role === 'user'" class="group relative flex max-w-[85%] flex-col items-end gap-1.5">
            <!-- Stacked attachment row above the prompt: used on narrow panels, during edit, or whenever attachmentsAside doesn't apply. -->
            <ChatAttachmentStrip
                v-if="attachmentThumbs.length"
                :attachments="attachmentThumbs"
                class="flex-wrap justify-end"
                :class="attachmentsAside && '@lg:hidden'"
            />
            <div class="flex items-center gap-1">
                <!--
                    Beside-prompt thumbnail once the panel is wide enough (attachmentsAside gates it): costs only the taller element. Queried against
                    the transcript column.
                -->
                <ChatAttachmentStrip v-if="attachmentsAside" :attachments="attachmentThumbs" class="mr-1 hidden shrink-0 self-start @lg:flex" />
                <!-- `relative` belongs on the frame, not the scroller, so the fade and toggle chip don't scroll away with the clamped text. -->
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
                    <!-- Shown only when the clamp cut the text. Expanding doesn't unpin: past the cap the open bubble scrolls internally. -->
                    <button
                        v-if="overflowing"
                        type="button"
                        class="chat-prompt-toggle"
                        :aria-expanded="expanded"
                        :aria-label="expanded ? 'Collapse message' : 'Expand message'"
                        @click="toggleExpanded"
                    >
                        <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    </button>
                </div>
            </div>
            <!--
                Sent-time label sits in the margin beside the bubble, visible only on hover, so it costs no row height. Centered on the message via
                `inset-y-0` plus flex, not a transform.
            -->
            <span
                v-if="sentClock"
                v-tooltip.top="sentExact"
                class="absolute inset-y-0 right-full mr-2 flex items-center text-2xs whitespace-nowrap tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100"
                >{{ sentClock }}</span
            >
            <!--
                Edit pencil sits in the gutter's own column (the fork mark's lane), costing no width. Pinned to the message's top, not centered,
                since it acts on the first line.
            -->
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
            <!--
                Mark, sentence and clock are one non-wrapping group inside the wrapping row: a sentence wider than the
                pane must wrap inside its own span, and as three siblings of a `flex-wrap` row it would instead take a
                line of its own and strand the mark above it and the clock below. The offers below stay siblings, since
                wrapping is exactly what they want.
            -->
            <span class="flex min-w-0 items-baseline gap-x-2">
                <!-- Spins and shows elapsed time while the notice's wait runs, then settles to a plain line (ChatMessage.noticeWait). -->
                <Icon v-if="pendingWait" name="spinner" spin class="shrink-0 text-2xs text-info" />
                <Icon v-else name="info-circle" class="shrink-0 text-2xs" />
                <span class="min-w-0">{{ message.text }}</span>
                <span v-if="pendingWait" class="shrink-0 tabular-nums">{{ formatElapsed(pendingWait.since, now) }}</span>
            </span>
            <!-- Optional follow-up offer on a notice (see holdOffer): a link, not a button, stated as a trailing clause. -->
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
            <!-- Shared with the Subagents area: a delegated agent's reasoning reads the same as this turn's own. -->
            <ChatThinking v-if="message.thinking" :thinking="message.thinking" :streaming="streaming" />

            <!-- `live` marks the bubble the turn is currently writing into; elsewhere tool calls and todos are a frozen record and must not animate. -->
            <div v-if="message.tools?.length" class="flex w-full flex-col gap-1">
                <ChatToolRows v-if="showToolCalls" :tools="message.tools" :live="streaming" />
                <ChatToolRun v-else :tools="message.tools" :live="streaming" />
            </div>

            <ChatTodoList v-if="message.todos?.length" :todos="message.todos" :live="streaming" />

            <!--
                Rendered as useMarkdown's parts (prose runs, figures), so a settled run's DOM stays untouched while only the tail re-renders.
                `.md-part` uses display:contents to keep prose a direct child of `.chat-markdown`.
            -->
            <div v-if="message.text" class="md-prose chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5">
                <template v-for="(part, index) in body" :key="index">
                    <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                    <MarkdownFigure v-else :figure="part.figure" />
                </template>
            </div>
            <!-- Marks a message the user wrote in the agent's voice (composer "as agent"); the agent itself never sees this flag. -->
            <p
                v-if="message.placed"
                class="flex items-center gap-1 px-1 text-2xs text-subtle"
                v-tooltip.top="`You wrote this in the agent's voice: the agent reads it as its own words`"
            >
                <Icon name="pencil" class="text-2xs" />Placed by you
            </p>

            <!-- The plan's own heading, not prose; the body below repeats it. -->
            <ChatCard
                v-if="message.plan"
                icon="list-check"
                icon-class="text-link"
                :title="planTitle(message.plan)"
                :status="planStatus(message.plan)"
            >
                <div class="md-prose chat-markdown chat-markdown-compact chat-card-body">
                    <template v-for="(part, index) in plan" :key="index">
                        <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                        <MarkdownFigure v-else :figure="part.figure" />
                    </template>
                </div>
                <!--
                    Shown only when the model wrote the plan to a file and summarized it in the adjacent prose (agent.ts). Height is
                    viewport-relative, capped at 40rem.
                -->
                <ChatDocumentBody
                    v-if="message.plan.document"
                    :document="message.plan.document"
                    foldable
                    in-card
                    :open="!documentDrawn(message.plan.document)"
                    :titled="documentTitled(planTitle(message.plan), message.plan.document)"
                    max-height="min(58dvh, 40rem)"
                    class="chat-card-doc-top-rule chat-card-doc-bottom-rule"
                />
                <template v-if="message.plan.status === 'pending'" #actions>
                    <!-- Single approval, not a posture menu: approving a plan approves the work inside the isolation boundary. -->
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePlan(message, true)"
                        >Approve</ChatDecisionButton
                    >
                    <ChatDecisionButton tone="secondary" icon="pencil" :disabled="settling" @click="decidePlan(message, false)"
                        >No, keep planning</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- Question text wraps in full rather than truncating; a multi-question card uses a generic title (ChatCard's `prose` mode). -->
            <ChatCard
                v-if="message.question"
                icon="comments"
                icon-class="text-link"
                prose
                :title="message.question.questions.length > 1 ? 'A few questions' : (message.question.questions[0]?.question ?? '')"
                :status="questionStatus(message.question)"
            >
                <!-- The write-up this turn produced that the question's options refer to (agent.ts attaches it); folds once already drawn elsewhere. -->
                <ChatDocumentBody
                    v-if="message.question.document"
                    :document="message.question.document"
                    foldable
                    in-card
                    :open="!documentDrawn(message.question.document)"
                    max-height="min(58dvh, 40rem)"
                    class="chat-card-doc-bottom-rule"
                />
                <div class="chat-card-body flex flex-col gap-4">
                    <div v-for="(question, index) in message.question.questions" :key="index" class="flex flex-col gap-2">
                        <span v-if="message.question.questions.length > 1" class="chat-question-title text-xs font-medium text-content">{{
                            question.question
                        }}</span>

                        <div v-if="message.question.status === 'pending'" class="flex flex-col gap-1.5">
                            <!--
                                States in words what the square marks already say by shape, shown only for multi-select; becomes a running count once
                                picked.
                            -->
                            <span v-if="question.multiSelect" class="text-2xs text-subtle">{{
                                pickedCount(index) > 0 ? `${pickedCount(index)} selected` : "Select all that apply"
                            }}</span>
                            <!--
                                ARIA roles mirror the visual marks; the Other text field stays outside the group since it's that row's payload, not a
                                separate option.
                            -->
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
                                    <!-- Muted, not subtle: the description is read before choosing, not glanced past. -->
                                    <span class="flex min-w-0 flex-col gap-0.5">
                                        <span class="text-xs font-medium text-content">{{ option.label }}</span>
                                        <span class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                        <!--
                                            Preformatted mockup (ASCII layout, diff, config) so options are compared side by side, all visible at
                                            once.
                                        -->
                                        <pre
                                            v-if="option.preview"
                                            class="scrollbar-thin mt-1 max-h-56 overflow-auto whitespace-pre rounded-md border border-line bg-canvas px-2 py-1.5 font-mono text-[0.65rem] leading-snug text-muted"
                                            >{{ option.preview }}</pre>
                                    </span>
                                </button>
                                <!--
                                    "Other" is an ordinary option row, identical markup to the others; its field appears below once picked and keeps
                                    its text when unpicked.
                                -->
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
                                <!--
                                    Grows rather than a fixed one-line input, since answers here often run long. `text-base` below `md` avoids iOS's
                                    auto-zoom-on-focus.
                                -->
                                <textarea
                                    :ref="(el) => setOtherInput(index, el)"
                                    rows="1"
                                    :value="otherValue(index)"
                                    @input="onOtherInput(index, $event)"
                                    @keydown="otherKeydown"
                                    placeholder="Type your answer…"
                                    class="ui-field-box ui-field-sm scrollbar-thin max-h-48 resize-none overflow-y-auto leading-relaxed"
                                ></textarea>
                                <!-- Shown from the moment the row is picked, not as an error; explains the disabled Submit. -->
                                <span v-if="otherPending(index)" class="text-2xs text-subtle">Write your answer to submit.</span>
                            </div>
                        </div>
                        <!-- Frozen view of a decided question: no interactive affordances and no preview, since choosing is already done. -->
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
                                    <!-- Rejected options keep the live card's description color; only the label dims. -->
                                    <span v-if="option.description" class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- In the shared answer-actions row, like every other card, not floating under the last option. -->
                <template v-if="message.question.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="!canSubmit || settling" @click="submitAnswers"
                        >Submit</ChatDecisionButton
                    >
                    <!-- Dismiss ends the turn (Conversation.cancelQuestion); the tooltip says so before the click. -->
                    <ChatDecisionButton
                        tone="secondary"
                        :disabled="settling"
                        v-tooltip.bottom="'Also stops the turn'"
                        @click="cancelQuestion(message)"
                        >Dismiss</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- The safety judge's own verdict sentence on this program, never from the gated agent's own words; wraps in full. -->
            <ChatCard v-if="message.permission" icon="shield" prose :title="permissionTitle" :status="permissionStatus(message.permission)">
                <div class="chat-card-body flex flex-col gap-2">
                    <!-- Shown only when it adds to the title (a hard-rule consequence, or a machine name); omitted otherwise. -->
                    <span v-if="message.permission.explain" class="text-xs leading-relaxed text-content/85">{{ message.permission.explain }}</span>
                    <span v-else-if="message.permission.description" class="text-xs text-content/85">{{ message.permission.description }}</span>

                    <template v-if="message.permission.program">
                        <!-- Click-to-reveal disclosure, not a hover or tab, so the command stays reachable on touch and keyboard. -->
                        <button
                            type="button"
                            :class="ui.textAction(`gap-1 text-2xs`)"
                            :aria-expanded="commandOpen"
                            @click="commandOpen = !commandOpen"
                        >
                            <Icon :name="commandOpen ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                            {{ commandOpen ? "Hide the command" : "Show the command" }}
                        </button>
                        <ChatCommandBlock v-if="commandOpen" :program="message.permission.program" />
                    </template>

                    <span v-if="message.permission.path" class="font-mono text-2xs leading-snug text-subtle">{{ message.permission.path }}</span>
                    <span v-if="message.permission.reason" class="text-2xs leading-snug text-subtle"
                        >Requested because: {{ message.permission.reason }}</span
                    >
                </div>

                <template v-if="message.permission.status === 'pending'" #actions>
                    <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="decidePermission(message, 'once')"
                        >Allow once</ChatDecisionButton
                    >
                    <!-- Secondary tone, since a second filled button beside Allow once would read as a coin flip. -->
                    <ChatDecisionButton
                        v-if="message.permission.alwaysLabel"
                        tone="secondary"
                        icon="lock"
                        :disabled="settling"
                        @click="decidePermission(message, 'always')"
                        >{{ message.permission.alwaysLabel }}</ChatDecisionButton
                    >
                    <!-- Like the question card's Dismiss: a refusal with no redirect ends the turn. -->
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

            <!-- The agent's browser needs a person; the primary action navigates to /browsers, where the live stage and hand-back live. -->
            <ChatCard
                v-if="message.browserHelp"
                icon="desktop"
                icon-class="text-warning"
                :title="`The agent's browser needs you: ${message.browserHelp.account}`"
                :status="helpStatus(message.browserHelp)"
            >
                <div class="chat-card-body flex flex-col gap-1">
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

            <!-- The agent's terminal needs a person at a prompt it can't answer; the browser card's twin, navigating to the terminal panel. -->
            <ChatCard
                v-if="message.terminalHelp"
                icon="terminal"
                icon-class="text-warning"
                title="The agent's terminal needs you"
                :status="helpStatus(message.terminalHelp)"
            >
                <div class="chat-card-body flex flex-col gap-1">
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

            <!--
                USDC spend gate: every figure comes from the endpoint's 402 challenge and the wallet ledger, never the model; only `why` is the
                agent's words.
            -->
            <ChatCard
                v-if="message.paymentOffer"
                icon="credit-card"
                :title="`Pay $${message.paymentOffer.offer.amountUsd} ${message.paymentOffer.offer.assetName}?`"
                :status="offerStatus(message.paymentOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <span v-if="message.paymentOffer.offer.description" class="text-xs text-content/85">{{
                        message.paymentOffer.offer.description
                    }}</span>
                    <!-- Full URL on hover, since a truncated host is exactly how a lookalike endpoint gets paid. -->
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

                <!-- From the endpoint's own settlement answer; an unsettled payment spends nothing, since the authorization simply expires. -->
                <div v-if="message.paymentOffer.receipt" class="chat-card-row">
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

            <!--
                The only card addressed to named approvers, not whoever's reading: the daemon verifies identity against that list
                (secrets/credential-gate.ts).
            -->
            <ChatCard
                v-if="message.credentialOffer"
                icon="key"
                :title="`Release ${message.credentialOffer.offer.subject} to the agent?`"
                :status="offerStatus(message.credentialOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <!-- What's about to happen, phrased for the reader, not the daemon's internal terms. -->
                    <span class="text-xs text-content/85">{{ credentialLane(message.credentialOffer.offer) }}</span>
                    <!-- Reference-form, not yet substituted with the real value, which is what makes it safe to show. -->
                    <span
                        v-if="message.credentialOffer.offer.detail"
                        class="truncate font-mono text-2xs text-subtle"
                        v-tooltip.left.overflow="message.credentialOffer.offer.detail"
                        >{{ message.credentialOffer.offer.detail }}</span
                    >
                    <span v-if="message.credentialOffer.offer.why" class="text-2xs text-subtle"
                        >The agent's case: {{ message.credentialOffer.offer.why }}</span
                    >
                    <span class="truncate text-2xs text-subtle" v-tooltip.left.overflow="message.credentialOffer.offer.approvers.join(`, `)"
                        >Approvers: {{ message.credentialOffer.offer.approvers.join(`, `) }}</span
                    >
                    <!-- Scope comes from policy, not the click, so the label never overstates what one yes covers. -->
                    <span class="pt-1 text-xs text-content">{{
                        message.credentialOffer.offer.scope === `conversation`
                            ? `Releasing it covers the rest of this conversation.`
                            : `Releasing it covers this one use. The next one asks again.`
                    }}</span>
                </div>

                <!-- Nothing shown for an unanswered card; the header chip already says so. -->
                <div v-if="message.credentialOffer.receipt" class="chat-card-row">
                    <span v-if="message.credentialOffer.receipt.outcome === 'released'" class="truncate text-2xs text-muted"
                        >Released by {{ message.credentialOffer.receipt.approvedBy }}</span
                    >
                    <span v-else class="text-2xs text-muted"
                        >Refused<template v-if="message.credentialOffer.receipt.approvedBy">
                            by {{ message.credentialOffer.receipt.approvedBy }}</template
                        >: the agent was told to carry on without it.</span
                    >
                </div>

                <template v-if="message.credentialOffer.status === 'pending'" #actions>
                    <ChatDecisionButton
                        tone="primary"
                        icon="check"
                        :disabled="settling || !mayRelease"
                        v-tooltip="mayRelease ? undefined : `Only ${message.credentialOffer.offer.approvers.join(`, `)} can release this`"
                        @click="decideCredentialOffer(message, true)"
                        >Release</ChatDecisionButton
                    >
                    <!-- Declining is approver-only too, or anyone with a session could stop someone else's turn. -->
                    <ChatDecisionButton
                        tone="secondary"
                        icon="times"
                        :disabled="settling || !mayRelease"
                        v-tooltip="mayRelease ? undefined : `Only ${message.credentialOffer.offer.approvers.join(`, `)} can answer this`"
                        @click="decideCredentialOffer(message, false)"
                        >Skip</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!--
                Title and id come from the daemon-validated catalog, never the model. Connect is both a decision and a navigation to the Capabilities
                page.
            -->
            <ChatCard
                v-if="message.capabilityOffer"
                icon="bolt"
                :title="`${message.capabilityOffer.offer.name} isn't connected yet`"
                :status="capabilityStatus(message.capabilityOffer)"
            >
                <div class="chat-card-body flex flex-col gap-1">
                    <span v-if="capabilityDescription" class="text-xs text-content/85">{{ capabilityDescription }}</span>
                    <span v-if="message.capabilityOffer.offer.why" class="text-2xs text-subtle"
                        >The agent's case: {{ message.capabilityOffer.offer.why }}</span
                    >
                </div>

                <!-- Shown while the agent waits on setup, with a way back to the form if it was closed mid-flow. -->
                <div
                    v-if="message.capabilityOffer.status === 'connecting' && !message.capabilityOffer.outcome"
                    class="chat-card-row flex items-center gap-2"
                >
                    <Icon name="spinner" class="text-2xs text-link" spin />
                    <span class="min-w-0 flex-1 truncate text-2xs text-muted">Waiting for you to finish setup…</span>
                    <ChatDecisionButton tone="secondary" icon="bolt" :to="capabilitySetupAt(message.capabilityOffer.offer.card)"
                        >Open setup</ChatDecisionButton
                    >
                </div>

                <!-- How the accepted ask resolved: what the agent did next. -->
                <div v-if="message.capabilityOffer.outcome" class="chat-card-row">
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
                    <!-- Final for this conversation: the agent continues without it and won't ask again. -->
                    <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="decideCapabilityOffer(message, false)"
                        >Not now</ChatDecisionButton
                    >
                </template>
            </ChatCard>

            <!-- Same component ChatPane mounts at the column's foot for a turn with no bubble yet — one spinner, one status line. -->
            <ChatTurnStatus v-if="showTyping" />
        </template>

        <!-- Trailer belongs to the turn's opener, whatever it turned out to be (prompt, errand, or restored assistant text). -->
        <span v-if="trailer" class="text-2xs text-subtle"
            >↳ {{ trailer.label }}<template v-if="trailer.count > 1"> ×{{ trailer.count }}</template></span
        >
    </div>

    <!--
        One line naming each note the daemon prepended, opening to the exact text. Its own row outside `.chat-prompt`, so it doesn't ride the pinned
        band.
    -->
    <div v-if="message.notes?.length" class="chat-message chat-stack flex flex-col" :class="{ 'chat-doomed': doomed }">
        <ChatFold icon="info-circle" label="Sent with your message" :detail="noteTitles">
            <div class="flex flex-col gap-3">
                <div v-for="note in message.notes" :key="note.title" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ note.title }}</span>
                    <span class="whitespace-pre-wrap">{{ noteBody(note.text) }}</span>
                </div>
            </div>
        </ChatFold>
    </div>
</template>
