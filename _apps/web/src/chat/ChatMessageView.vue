<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import type { AskQuestion } from "@intentic/sandbox-contract";
import { computed, nextTick, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { type ChatMessage, planParts, type PlanRequest } from "../composables/chat/transcript";
import { copyCodeFromEvent } from "../composables/markdownCode";
import { useMarkdown } from "../composables/useMarkdown";
import { openFileRefFromEvent } from "../composables/workspace/openFileRef";
import { restoreSnapshot } from "../composables/workspace/useHistory";
import { useChat } from "../composables/chat/useChat";
import ChatImageThumb from "./ChatImageThumb.vue";
import ChatTodoList from "./ChatTodoList.vue";
import ChatToolCard from "./ChatToolCard.vue";

/* One transcript entry: user bubble, notice line, or the assistant turn's stack (thinking, tools, todos,
 * markdown text, plan card, question card, typing loader). Card decisions go straight to the useChat
 * singleton; per-message UI state (thinking fold, question picks) lives here, scoped to this instance. */

const props = defineProps<{
    message: ChatMessage;
    // True while this message is the turn currently being streamed.
    streaming: boolean;
}>();

const {
    decidePlan,
    planApprovals,
    answerQuestion,
    cancelQuestion,
    decidePermission,
    openPlanPreview,
    editAndResend,
    streaming: conversationStreaming,
    awaitingDecision,
} = useChat();
const { mobile } = useDevice();

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
// the component's life — the list is keyed by message id, so an instance tracks one message throughout.
const body = useMarkdown(
    () => props.message.text,
    () => props.streaming,
);
// A plan card's body arrives whole with the card, so it never streams.
const plan = useMarkdown(() => (props.message.plan ? planParts(props.message.plan.text).body : ``), false);

const planTitle = (request: PlanRequest): string => planParts(request.text).title ?? `Proposed plan`;

// One delegated listener for every control the rendered markdown carries — a code block's copy button and the
// file links a mentioned path becomes. Both live inside v-html, so neither can hold a component of its own.
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
// else the bare tool name — so the card reads like Claude Code's prompt rather than a raw tool dump.
const permissionTitle = computed(() => {
    const permission = props.message.permission;
    if (permission === undefined) {
        return ``;
    }
    return permission.title ?? permission.displayName ?? permission.toolName;
});

// Keep the loader visible for the whole live turn, not just before the first token. The model streams a
// preamble sentence and then goes quiet while it runs tools and thinks — text is present but the turn isn't
// done. Anchored at the bottom of the assistant stack, the loader tells the user work is still in flight;
// it disappears only when streaming ends or a card takes over the prompt.
//
// A pending card is the one case where the turn is still streaming (its fetch stays open) while nothing is
// being computed — the card is the prompt, so the loader must yield to it. Read the CONVERSATION's flag, not
// this message's own cards: a card parks the whole turn but hangs on whichever bubble was current when it
// arrived, which isn't always the bubble the loader trails (a plan nulls the turn's bubble, so later frames
// open a fresh one below the card). Per-message, that left "Scheming… (107s)" ticking under a permission
// prompt the agent was already blocked on.
const showTyping = computed(() => props.streaming && !awaitingDecision.value);

// Cycling status-word loader shown while the turn streams: tick once a second so the word cycles (every ~2s)
// and the elapsed counter advances; torn down as soon as streaming stops.
let loaderStartedAt = 0;
const loaderTick = ref(0);
const loaderWord = computed(() => LOADER_WORDS[Math.floor(loaderTick.value / 2) % LOADER_WORDS.length] ?? `Thinking`);
const loaderSeconds = computed(() => {
    void loaderTick.value; // read the tick so this re-evaluates each second
    return Math.max(0, Math.floor((Date.now() - loaderStartedAt) / 1000));
});
watch(
    () => props.streaming,
    (isStreamingNow, _prev, onCleanup) => {
        if (!isStreamingNow) {
            return;
        }
        loaderStartedAt = Date.now();
        const timer = setInterval(() => (loaderTick.value += 1), 1000);
        onCleanup(() => clearInterval(timer));
    },
    { immediate: true },
);

// --- Interactive question card ---------------------------------------------------------------
// Local selection state for a pending question card, keyed by question index.
const selections = ref<Record<number, string[]>>({});
const otherTexts = ref<Record<number, string>>({});

const isSelected = (index: number, label: string): boolean => (selections.value[index] ?? []).includes(label);

const toggleOption = (question: AskQuestion, index: number, label: string): void => {
    const current = selections.value[index] ?? [];
    let next: string[];
    if (question.multiSelect) {
        next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
    } else {
        // Single-select: clicking the active option clears it, otherwise it replaces the choice. And,
        // matching Claude Code, a listed option and the free-text "Other" are mutually exclusive — so
        // picking one clears whatever was typed.
        next = current.includes(label) ? [] : [label];
        if (next.length > 0) {
            otherTexts.value = { ...otherTexts.value, [index]: `` };
        }
    }
    selections.value = { ...selections.value, [index]: next };
};

const otherValue = (index: number): string => otherTexts.value[index] ?? ``;
const setOther = (question: AskQuestion, index: number, value: string): void => {
    otherTexts.value = { ...otherTexts.value, [index]: value };
    // The other half of the single-select exclusivity above: typing a custom answer drops the picked option.
    if (!question.multiSelect && value.length > 0) {
        selections.value = { ...selections.value, [index]: [] };
    }
};

// Combined picks for one question: selected option label(s) plus any non-empty "Other" text.
const picksFor = (index: number): string[] => {
    const labels = selections.value[index] ?? [];
    const other = otherValue(index).trim();
    return other.length > 0 ? [...labels, other] : labels;
};

const canSubmit = computed(() => props.message.question?.questions.every((_, index) => picksFor(index).length > 0) ?? false);

const submitAnswers = (): void => {
    const question = props.message.question;
    if (!question || !canSubmit.value) {
        return;
    }
    const answers: Record<string, string[]> = {};
    question.questions.forEach((q, index) => {
        answers[q.question] = picksFor(index);
    });
    void answerQuestion(props.message, answers);
};

// A DECIDED question card is the record of the decision, so it keeps every option that was on the table and
// marks the one(s) taken — read back a week later, "Your original ×" means nothing without the alternatives it
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

// --- Per-message workspace restore (hover history icon on user bubbles) -----------------------
// Restores /work to the checkpoint captured before this turn ran (the daemon's checkpoint frame). Gated on
// the conversation-level stream like canEdit — no rewind may land while a turn is in flight.
const queryClient = useQueryClient();
const restoring = ref(false);
const confirmRestore = ref(false);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
const canRestore = computed(() => props.message.role === `user` && props.message.checkpointId !== undefined && !conversationStreaming.value);
const restoreToCheckpoint = async (): Promise<void> => {
    const checkpointId = props.message.checkpointId;
    if (checkpointId === undefined || restoring.value) {
        return;
    }
    if (!confirmRestore.value) {
        confirmRestore.value = true;
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => (confirmRestore.value = false), 4000);
        return;
    }
    clearTimeout(confirmTimer);
    confirmRestore.value = false;
    restoring.value = true;
    try {
        await restoreSnapshot(queryClient, checkpointId);
    } finally {
        restoring.value = false;
    }
};

// --- Long prompt clamp (see .chat-prompt-text) ------------------------------------------------
// The bubble is clamped in CSS; whether the clamp actually bites is a question of wrapping, and wrapping
// depends on a panel width the user can drag. So the element is measured rather than its text guessed at,
// and re-measured whenever it resizes — a prompt that fits at a wide panel clips at a narrow one, and a
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
            // Open, the clamp is off and the box always fits — there is nothing to measure, and measuring
            // would clear the flag that keeps the collapse control on screen. The next collapse re-measures.
            if (!expanded.value) {
                overflowing.value = element.scrollHeight > element.clientHeight + 1;
            }
        });
        observer.observe(element);
        onCleanup(() => observer.disconnect());
    },
    { immediate: true },
);

// A clamped box has no scrollbar and cannot be scrolled by hand, so any scroll it reports came from the
// browser revealing something inside it — find-in-page landing on a match below the fold, or a screen reader
// moving to it. Both mean the same thing: open the message, and put the box back where it belongs.
const onBubbleScroll = (): void => {
    if (bubble.value !== undefined && bubble.value.scrollTop > 0) {
        expanded.value = true;
        bubble.value.scrollTop = 0;
    }
};

// --- Inline edit of a past user message (hover pencil → textarea → branch from here) ---------
const editing = ref(false);
const editText = ref(``);
const editInput = ref<HTMLTextAreaElement>();

// The gate is the conversation-level stream (via useChat), not the per-message `streaming` prop: no branch
// may be taken while any turn of this chat is in flight (a parked plan/question card keeps the fetch open too).
const canEdit = computed(() => props.message.role === `user` && !conversationStreaming.value);
// Mirrors send's guard: an attachment-only re-run is legal, an entirely empty one is not.
const canSubmitEdit = computed(() => editText.value.trim().length > 0 || (props.message.attachments?.length ?? 0) > 0);

// Manual auto-grow, the composer's grow() pattern bound to this instance's textarea.
const growEdit = (): void => {
    const el = editInput.value;
    if (!el) {
        return;
    }
    el.style.height = `auto`;
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
};

const startEdit = (): void => {
    if (!canEdit.value) {
        return;
    }
    editText.value = props.message.text;
    editing.value = true;
    void nextTick(() => {
        growEdit();
        editInput.value?.focus();
    });
};

const cancelEdit = (): void => {
    editing.value = false;
};

const submitEdit = (): void => {
    if (!canSubmitEdit.value || conversationStreaming.value) {
        return;
    }
    editing.value = false;
    // The branch opens in a new tab and takes focus; this conversation is left exactly as it was.
    void editAndResend(props.message, editText.value);
};

const onEditKeydown = (event: KeyboardEvent): void => {
    // Never act mid-IME-composition (CJK candidates confirm with Enter).
    if (event.isComposing) {
        return;
    }
    if (event.key === `Escape`) {
        event.preventDefault();
        cancelEdit();
        return;
    }
    // On mobile Enter is a newline (the buttons submit) — the virtual keyboard has no Shift+Enter.
    if (event.key !== `Enter` || mobile.value) {
        return;
    }
    if (!event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        submitEdit();
    }
};
</script>

<template>
    <!-- The click handler is delegated for the markdown's own controls — copy buttons and file links — which
         live inside v-html and so can hold no component of their own (see onMarkdownClick). -->
    <div
        class="chat-message flex flex-col gap-1"
        :class="{ 'chat-prompt items-end': message.role === 'user', 'chat-prompt-open': expanded }"
        @click="onMarkdownClick"
    >
        <div v-if="message.role === 'user'" class="group flex max-w-[85%] flex-col items-end gap-1.5" :class="{ 'w-full': editing }">
            <!-- The chip/thumbnail row stays visible in edit mode (read-only — the attachments ride the re-run). -->
            <div v-if="message.attachments?.length" class="flex flex-wrap justify-end gap-1.5">
                <template v-for="attachment in message.attachments" :key="attachment.path">
                    <ChatImageThumb v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" size="h-14 w-14" />
                    <span v-else class="chat-surface flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-content/90">
                        <Icon name="file" class="text-2xs text-subtle" />
                        {{ attachment.name }}
                    </span>
                </template>
            </div>
            <template v-if="editing">
                <!-- text-base below md: 16px is the iOS threshold under which focusing zooms the page. -->
                <textarea
                    ref="editInput"
                    v-model="editText"
                    rows="1"
                    class="chat-surface scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto rounded-lg px-3 py-2 text-base leading-relaxed text-content focus:outline-none md:text-xs"
                    @input="growEdit"
                    @keydown="onEditKeydown"
                ></textarea>
                <div class="flex items-center gap-1">
                    <button type="button" class="composer-ghost h-6 px-2 text-2xs" @click="cancelEdit">Cancel</button>
                    <button
                        type="button"
                        class="composer-ghost h-6 gap-1 px-2 text-2xs disabled:cursor-default disabled:opacity-50"
                        :disabled="!canSubmitEdit"
                        v-tooltip.top="'Send as a new branch — this conversation is kept'"
                        @click="submitEdit"
                    >
                        <Icon name="send" class="text-2xs" />
                        Send
                    </button>
                </div>
            </template>
            <div v-else class="flex items-center gap-1">
                <!-- Restore the workspace to the checkpoint captured before this turn ran. Two-step: the first
                     click arms (red), the second restores; arming decays after 4s. -->
                <button
                    v-if="canRestore"
                    type="button"
                    class="composer-ghost h-6 w-6 shrink-0 transition-opacity"
                    :class="[
                        mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                        { 'text-danger opacity-100': confirmRestore },
                    ]"
                    v-tooltip.left="
                        confirmRestore ? 'Click again to restore the workspace to before this message' : 'Restore workspace to before this message'
                    "
                    aria-label="Restore workspace to before this message"
                    @click="restoreToCheckpoint"
                >
                    <Icon :name="restoring ? 'spinner' : 'history'" :spin="restoring" class="text-2xs" />
                </button>
                <!-- Edit & re-run from here: hover-revealed on desktop, always dimly visible on touch. -->
                <button
                    v-if="canEdit"
                    type="button"
                    class="composer-ghost h-6 w-6 shrink-0 transition-opacity"
                    :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                    v-tooltip.left="'Edit & branch from here'"
                    aria-label="Edit message"
                    @click="startEdit"
                >
                    <Icon name="pencil" class="text-2xs" />
                </button>
                <div
                    v-if="message.text"
                    ref="bubble"
                    class="chat-prompt-text chat-surface whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed text-content/90"
                    @scroll="onBubbleScroll"
                >
                    {{ message.text }}
                </div>
            </div>
            <!-- Only for a prompt the clamp actually cut. Opening it also unpins it, so a long message can be
                 read in full without taking the screen over for the rest of the turn. -->
            <button v-if="overflowing" type="button" class="composer-ghost h-5 gap-1 px-1.5 text-2xs" @click="expanded = !expanded">
                {{ expanded ? `Show less` : `Show more` }}
                <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
            </button>
        </div>
        <div v-else-if="message.role === 'notice'" class="flex items-center gap-2 self-center py-0.5 text-2xs text-subtle">
            <Icon name="info-circle" class="text-2xs" />
            <span>{{ message.text }}</span>
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
                 turn is currently writing into. Anywhere else they are a record — frozen mid-flight by a Stop,
                 by the turn moving on, or by the session ending — and must not animate. -->
            <div v-if="message.tools?.length" class="flex w-full flex-col gap-1">
                <ChatToolCard v-for="tool in message.tools" :key="tool.id" :tool="tool" :live="streaming" />
            </div>

            <ChatTodoList v-if="message.todos?.length" :todos="message.todos" :live="streaming" />

            <!-- Two v-html slots, not one: the settled half is unchanged between frames so Vue leaves its DOM
                 (and the user's selection) alone, while only the short tail is re-rendered. `.md-part` is
                 display:contents, so the prose still lays out as direct children of .chat-markdown. -->
            <div v-if="message.text" class="md-prose chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5">
                <div v-if="body.settled" class="md-part" v-html="body.settled"></div>
                <div v-if="body.tail" class="md-part" v-html="body.tail"></div>
            </div>

            <div v-if="message.plan" class="chat-surface w-full overflow-hidden rounded-xl">
                <div class="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <Icon name="list-check" class="text-sm text-link" />
                    <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content" v-tooltip.bottom="planTitle(message.plan)">{{
                        planTitle(message.plan)
                    }}</span>
                    <span v-if="message.plan.status === 'approved'" class="text-2xs font-medium text-success">✓ Approved</span>
                    <span v-else-if="message.plan.status === 'rejected'" class="text-2xs font-medium text-muted">✕ Kept planning</span>
                    <span v-else-if="message.plan.status === 'cancelled'" class="text-2xs font-medium text-muted">✕ Stopped</span>
                    <button
                        type="button"
                        class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-content"
                        v-tooltip.bottom="'Open in main view'"
                        aria-label="Open plan in main view"
                        @click="openPlanPreview(message.plan)"
                    >
                        <Icon name="window-maximize" class="text-xs" />
                    </button>
                </div>
                <div class="md-prose chat-markdown chat-markdown-compact px-3.5 py-3" v-html="plan.settled"></div>
                <div v-if="message.plan.status === 'pending'" class="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
                    <!-- The first approval restores the posture the conversation was in before it planned; the
                         rest are the other two postures, so any of them is one click away. -->
                    <button
                        v-for="(approval, index) in planApprovals"
                        :key="approval.mode"
                        type="button"
                        :class="index === 0 ? 'plan-approve' : 'plan-reject'"
                        @click="decidePlan(message, true, approval.mode)"
                    >
                        <Icon name="check" class="text-xs" />
                        {{ approval.label }}
                    </button>
                    <button type="button" class="plan-reject" @click="decidePlan(message, false, 'plan')">
                        <Icon name="pencil" class="text-xs" />
                        No, keep planning
                    </button>
                </div>
            </div>

            <div v-if="message.question" class="chat-surface w-full overflow-hidden rounded-xl">
                <!-- The question wraps in full here rather than truncating behind a tooltip; a multi-question
                     card carries a generic title and breaks each question out inline in the body below. -->
                <div class="flex items-start gap-2 border-b border-line px-3.5 py-2">
                    <Icon name="comments" class="mt-0.5 text-sm text-link" />
                    <span class="min-w-0 flex-1 text-sm font-semibold text-content">{{
                        message.question.questions.length > 1 ? "A few questions" : message.question.questions[0]?.question
                    }}</span>
                    <span v-if="message.question.status === 'answered'" class="mt-0.5 shrink-0 text-2xs font-medium text-success">✓ Answered</span>
                    <span v-else-if="message.question.status === 'cancelled'" class="mt-0.5 shrink-0 text-2xs font-medium text-muted"
                        >✕ Dismissed</span
                    >
                </div>

                <div class="flex flex-col gap-4 px-3.5 py-3">
                    <div v-for="(question, index) in message.question.questions" :key="index" class="flex flex-col gap-2">
                        <span v-if="message.question.questions.length > 1" class="text-xs font-medium text-content">{{ question.question }}</span>

                        <div v-if="message.question.status === 'pending'" class="flex flex-col gap-1.5">
                            <button
                                v-for="option in question.options"
                                :key="option.label"
                                type="button"
                                class="qopt flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors"
                                :class="{ 'qopt-on': isSelected(index, option.label) }"
                                v-tooltip.left="option.preview ?? ''"
                                @click="toggleOption(question, index, option.label)"
                            >
                                <Icon
                                    class="mt-0.5 text-2xs"
                                    :name="isSelected(index, option.label) ? 'check-circle' : 'circle'"
                                    :class="isSelected(index, option.label) ? 'text-primary-500' : 'text-subtle'"
                                />
                                <!-- The description carries the actual trade-off between options, so it is muted
                                     rather than subtle: it is read before choosing, not glanced past. -->
                                <span class="flex min-w-0 flex-col gap-0.5">
                                    <span class="text-xs font-medium text-content">{{ option.label }}</span>
                                    <span class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                </span>
                            </button>
                            <!-- text-base below md: 16px is the iOS threshold under which focusing zooms the page. -->
                            <input
                                type="text"
                                :value="otherValue(index)"
                                @input="setOther(question, index, ($event.target as HTMLInputElement).value)"
                                placeholder="Other…"
                                class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-base text-content placeholder:text-subtle focus:border-line-strong focus:outline-none md:text-xs"
                            />
                        </div>
                        <!-- Decided (answered or dismissed): the same options, frozen. Nothing here may read as
                             a control — no button, no hover, no focus stop, and no empty radio, which is the
                             one mark that says "still yours to pick". Only the check moves. -->
                        <div v-else class="flex flex-col gap-1.5" role="list">
                            <div
                                v-for="option in decidedOptions(question)"
                                :key="option.label"
                                role="listitem"
                                class="flex items-start gap-2 rounded-lg border border-transparent px-2.5 py-2"
                                :class="{ 'qopt-picked': option.picked }"
                                v-tooltip.left="option.preview ?? ''"
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
                                         not subtle — the live card moved with the type scale, and this rule is
                                         stated against it, so it moves too. Weight and gap match the live row
                                         for the same reason: answering a card must not reflow it.) -->
                                    <span v-if="option.description" class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                </span>
                            </div>
                        </div>
                    </div>

                    <div v-if="message.question.status === 'pending'" class="flex items-center gap-2 pt-1">
                        <button
                            type="button"
                            class="plan-approve plan-sm disabled:cursor-default disabled:opacity-50"
                            :disabled="!canSubmit"
                            @click="submitAnswers"
                        >
                            <Icon name="check" class="text-2xs" />
                            Submit
                        </button>
                        <button type="button" class="plan-reject plan-sm" @click="cancelQuestion(message)">Dismiss</button>
                    </div>
                </div>
            </div>

            <div v-if="message.permission" class="chat-surface w-full overflow-hidden rounded-xl">
                <div class="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <Icon name="shield" class="text-sm text-primary-500" />
                    <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content" v-tooltip.bottom="permissionTitle">{{
                        permissionTitle
                    }}</span>
                    <span v-if="message.permission.status === 'allowed'" class="text-2xs font-medium text-success">✓ Allowed</span>
                    <span v-else-if="message.permission.status === 'always'" class="text-2xs font-medium text-success">✓ Always allowed</span>
                    <span v-else-if="message.permission.status === 'denied'" class="text-2xs font-medium text-muted">✕ Denied</span>
                    <span v-else-if="message.permission.status === 'cancelled'" class="text-2xs font-medium text-muted">✕ Stopped</span>
                </div>

                <div class="flex flex-col gap-1 px-3.5 py-3">
                    <span v-if="message.permission.description" class="text-xs text-content/85">{{ message.permission.description }}</span>
                    <span v-if="message.permission.path" class="font-mono text-2xs text-subtle">{{ message.permission.path }}</span>
                    <span v-if="message.permission.reason" class="text-2xs text-subtle">Requested because: {{ message.permission.reason }}</span>
                </div>

                <div v-if="message.permission.status === 'pending'" class="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
                    <button type="button" class="plan-approve" @click="decidePermission(message, 'once')">
                        <Icon name="check" class="text-xs" />
                        Allow once
                    </button>
                    <button v-if="message.permission.alwaysLabel" type="button" class="plan-reject" @click="decidePermission(message, 'always')">
                        <Icon name="lock" class="text-xs" />
                        {{ message.permission.alwaysLabel }}
                    </button>
                    <button type="button" class="plan-reject" @click="decidePermission(message, 'deny')">
                        <Icon name="times" class="text-xs" />
                        No
                    </button>
                </div>
            </div>

            <!-- The loader is a status line, not a message: it sits at the meta tier with the tool cards it
                 trails, and takes the assistant bubble's padding so the stack keeps one left edge. -->
            <div v-if="showTyping" class="flex items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
                <Icon name="spinner" class="text-2xs text-link" spin />
                <span
                    >{{ loaderWord }}… <span class="text-subtle">({{ loaderSeconds }}s)</span></span
                >
            </div>
        </template>
    </div>
</template>
