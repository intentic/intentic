<script setup lang="ts">
import { type IconName, useDevice } from "@intentic-app/ui";
import type { AskQuestion, TodoItem } from "@intentic/sandbox-contract";
import { computed, nextTick, ref, watch } from "vue";
import { type ChatMessage, type ChatTool, planParts, type PlanRequest } from "../composables/chat/conversation";
import { renderMarkdown } from "../composables/renderMarkdown";
import { useChat } from "../composables/chat/useChat";

/* One transcript entry: user bubble, notice line, or the assistant turn's stack (thinking, tools, todos,
 * markdown text, plan card, question card, typing loader). Card decisions go straight to the useChat
 * singleton; per-message UI state (thinking fold, question picks) lives here, scoped to this instance. */

const props = defineProps<{
    message: ChatMessage;
    // True while this message is the turn currently being streamed.
    streaming: boolean;
}>();

const { decidePlan, answerQuestion, cancelQuestion, openPlanPreview, editAndResend, streaming: conversationStreaming } = useChat();
const { mobile } = useDevice();

// Whimsical status words cycled while a turn streams before its first token (Claude Code style).
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
const render = (text: string): string => renderMarkdown(text);

// Cap a tool's output so a large file read / chatty command can't bloat the DOM (the box scrolls anyway).
// ponytail: 4k-char cap, raise it if real outputs get clipped.
const toolOutput = (tool: ChatTool): string => {
    const out = tool.output ?? ``;
    return out.length > 4000 ? `${out.slice(0, 4000)}\n… (truncated)` : out;
};

const todoIcon = (todo: TodoItem): { name: IconName; spin?: boolean; class: string } => {
    if (todo.status === `completed`) {
        return { name: `check-circle`, class: `text-success` };
    }
    if (todo.status === `in_progress`) {
        return { name: `spinner`, spin: true, class: `text-link` };
    }
    return { name: `circle`, class: `text-subtle` };
};
const todoText = (todo: TodoItem): string => (todo.status === `in_progress` && todo.activeForm ? todo.activeForm : todo.content);

const planTitle = (plan: PlanRequest): string => planParts(plan.text).title ?? `Proposed plan`;
const planBody = (plan: PlanRequest): string => planParts(plan.text).body;

// --- Thinking fold / typing loader -----------------------------------------------------------
// Manual override of the thinking section's expanded state. When unset, it defaults to expanded while the
// turn streams and collapsed once done.
const thinkingOverride = ref<boolean>();
const isThinkingOpen = computed(() => thinkingOverride.value ?? props.streaming);
const toggleThinking = (): void => {
    thinkingOverride.value = !isThinkingOpen.value;
};

// Show the typing indicator before any thinking or answer text has arrived for this turn.
const showTyping = computed(() => props.streaming && props.message.text.length === 0 && (props.message.thinking ?? ``).length === 0);

// Cycling status-word loader shown while the turn streams before its first token: tick once a second so the
// word cycles (every ~2s) and the elapsed counter advances; torn down as soon as streaming stops.
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
        // Single-select: clicking the active option clears it, otherwise it replaces the choice.
        next = current.includes(label) ? [] : [label];
    }
    selections.value = { ...selections.value, [index]: next };
};

const otherValue = (index: number): string => otherTexts.value[index] ?? ``;
const setOther = (index: number, value: string): void => {
    otherTexts.value = { ...otherTexts.value, [index]: value };
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

const answerSummary = (question: AskQuestion): string => (props.message.question?.answers?.[question.question] ?? []).join(`, `);

// --- Inline edit of a past user message (hover pencil → textarea → re-run from here) ----------
const editing = ref(false);
const editText = ref(``);
const editInput = ref<HTMLTextAreaElement>();

// The gate is the conversation-level stream (via useChat), not the per-message `streaming` prop: no rewind
// may land while any turn of this chat is in flight (a parked plan/question card keeps the fetch open too).
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
    // The rewind truncates the transcript at this message, so this component instance unmounts.
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
    <div class="flex flex-col gap-1" :class="{ 'items-end': message.role === 'user' }">
        <div v-if="message.role === 'user'" class="group flex max-w-[85%] flex-col items-end gap-1.5" :class="{ 'w-full': editing }">
            <!-- The chip/thumbnail row stays visible in edit mode (read-only — the attachments ride the re-run). -->
            <div v-if="message.attachments?.length" class="flex flex-wrap justify-end gap-1.5">
                <template v-for="attachment in message.attachments" :key="attachment.path">
                    <img
                        v-if="attachment.previewUrl"
                        :src="attachment.previewUrl"
                        :alt="attachment.name"
                        v-tooltip.top="attachment.name"
                        class="max-h-32 rounded-lg border border-line object-cover"
                    />
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
                    class="chat-surface scrollbar-thin block max-h-48 w-full resize-none overflow-y-auto rounded-lg px-3.5 py-2.5 text-base leading-6 text-content focus:outline-none md:text-sm"
                    @input="growEdit"
                    @keydown="onEditKeydown"
                ></textarea>
                <div class="flex items-center gap-1">
                    <button type="button" class="composer-ghost h-6 px-2 text-2xs" @click="cancelEdit">Cancel</button>
                    <button
                        type="button"
                        class="composer-ghost h-6 gap-1 px-2 text-2xs disabled:cursor-default disabled:opacity-50"
                        :disabled="!canSubmitEdit"
                        v-tooltip.top="'Re-run the conversation from here'"
                        @click="submitEdit"
                    >
                        <Icon name="send" class="text-2xs" />
                        Send
                    </button>
                </div>
            </template>
            <div v-else class="flex items-center gap-1">
                <!-- Edit & re-run from here: hover-revealed on desktop, always dimly visible on touch. -->
                <button
                    v-if="canEdit"
                    type="button"
                    class="composer-ghost h-6 w-6 shrink-0 transition-opacity"
                    :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                    v-tooltip.left="'Edit & re-run from here'"
                    aria-label="Edit message"
                    @click="startEdit"
                >
                    <Icon name="pencil" class="text-2xs" />
                </button>
                <div
                    v-if="message.text"
                    class="chat-surface whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-[0.8125rem] leading-[1.6] text-content/90"
                >
                    {{ message.text }}
                </div>
            </div>
        </div>
        <div v-else-if="message.role === 'notice'" class="flex items-center gap-2 self-center py-0.5 text-2xs text-subtle">
            <Icon name="info-circle" class="text-[0.65rem]" />
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

            <div v-if="message.tools?.length" class="flex w-full flex-col gap-1">
                <div v-for="(tool, index) in message.tools" :key="index" class="flex flex-col gap-0.5">
                    <div class="flex items-center gap-1.5 text-2xs text-subtle">
                        <Icon name="angle-right" class="text-2xs text-link" />
                        <span class="font-medium text-muted">{{ tool.name }}</span>
                        <span v-if="tool.target" class="truncate font-mono">{{ tool.target }}</span>
                    </div>
                    <pre
                        v-if="tool.output"
                        class="scrollbar-thin ml-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line bg-canvas px-2 py-1 text-2xs leading-relaxed"
                        :class="tool.isError ? 'text-danger' : 'text-muted'"
                        >{{ toolOutput(tool) }}</pre>
                </div>
            </div>

            <div v-if="message.todos?.length" class="flex w-full flex-col gap-1 rounded-lg border border-line bg-overlay/40 px-3 py-2">
                <div v-for="(todo, index) in message.todos" :key="index" class="flex items-start gap-2 text-xs">
                    <Icon v-bind="todoIcon(todo)" class="mt-0.5 text-2xs" />
                    <span :class="{ 'text-subtle': todo.status === 'completed', 'line-through': todo.status === 'completed' }">{{
                        todoText(todo)
                    }}</span>
                </div>
            </div>

            <div
                v-if="message.text"
                class="chat-markdown chat-surface-assistant w-full rounded-lg px-3.5 py-2.5 text-content/85"
                v-html="render(message.text)"
            ></div>

            <div v-if="message.plan" class="chat-surface w-full overflow-hidden rounded-xl">
                <div class="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <Icon name="list-check" class="text-sm text-link" />
                    <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content" v-tooltip.bottom="planTitle(message.plan)">{{
                        planTitle(message.plan)
                    }}</span>
                    <span v-if="message.plan.status === 'approved'" class="text-xs font-medium text-success">✓ Approved</span>
                    <span v-else-if="message.plan.status === 'rejected'" class="text-xs font-medium text-muted">✕ Kept planning</span>
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
                <div class="chat-markdown chat-markdown-compact px-3.5 py-3 text-content/85" v-html="render(planBody(message.plan))"></div>
                <div v-if="message.plan.status === 'pending'" class="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
                    <button type="button" class="plan-approve" @click="decidePlan(message, true)">
                        <Icon name="check" class="text-xs" />
                        Yes, proceed
                    </button>
                    <button type="button" class="plan-reject" @click="decidePlan(message, false)">
                        <Icon name="pencil" class="text-xs" />
                        No, keep planning
                    </button>
                </div>
            </div>

            <div v-if="message.question" class="chat-surface w-full overflow-hidden rounded-xl">
                <div class="flex items-center gap-2 border-b border-line px-3.5 py-2">
                    <Icon name="comments" class="text-sm text-link" />
                    <span
                        class="min-w-0 flex-1 truncate text-sm font-semibold text-content"
                        v-tooltip.bottom="message.question.questions[0]?.question ?? ''"
                        >{{ message.question.questions[0]?.question }}</span
                    >
                    <span v-if="message.question.status === 'answered'" class="text-xs font-medium text-success">✓ Answered</span>
                    <span v-else-if="message.question.status === 'cancelled'" class="text-xs font-medium text-muted">✕ Dismissed</span>
                </div>

                <div class="flex flex-col gap-4 px-3.5 py-3">
                    <div v-for="(question, index) in message.question.questions" :key="index" class="flex flex-col gap-2">
                        <div class="flex flex-col gap-0.5">
                            <span class="text-2xs uppercase tracking-wide text-subtle">{{ question.header }}</span>
                            <span v-if="message.question.questions.length > 1" class="text-sm font-medium text-content">{{ question.question }}</span>
                        </div>

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
                                    class="mt-0.5 text-xs"
                                    :name="isSelected(index, option.label) ? 'check-circle' : 'circle'"
                                    :class="isSelected(index, option.label) ? 'text-primary-500' : 'text-subtle'"
                                />
                                <span class="flex min-w-0 flex-col">
                                    <span class="text-sm text-content">{{ option.label }}</span>
                                    <span class="text-2xs text-subtle">{{ option.description }}</span>
                                </span>
                            </button>
                            <input
                                type="text"
                                :value="otherValue(index)"
                                @input="setOther(index, ($event.target as HTMLInputElement).value)"
                                placeholder="Other…"
                                class="rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                            />
                        </div>
                        <span v-else class="text-sm text-content/85">{{ answerSummary(question) || "—" }}</span>
                    </div>

                    <div v-if="message.question.status === 'pending'" class="flex items-center gap-2 pt-1">
                        <button
                            type="button"
                            class="plan-approve disabled:cursor-default disabled:opacity-50"
                            :disabled="!canSubmit"
                            @click="submitAnswers"
                        >
                            <Icon name="check" class="text-xs" />
                            Submit
                        </button>
                        <button type="button" class="plan-reject" @click="cancelQuestion(message)">Dismiss</button>
                    </div>
                </div>
            </div>

            <div
                v-if="!message.text && !message.plan && !message.question && showTyping"
                class="flex items-center gap-2 rounded-lg bg-overlay px-3.5 py-2.5 text-sm text-muted"
            >
                <Icon name="spinner" class="text-xs text-link" spin />
                <span
                    >{{ loaderWord }}… <span class="text-subtle">({{ loaderSeconds }}s)</span></span
                >
            </div>
        </template>
    </div>
</template>
