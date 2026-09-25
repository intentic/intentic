<!-- The AskUserQuestion card: the ask, the options, and the answer being composed. -->
<script setup lang="ts">
import { growTextarea, Icon, type IconName, useDevice } from "@intentic/ui";
import type { AskQuestion } from "@intentic/sandbox-contract";
import { type ComponentPublicInstance, computed, nextTick, ref, watch } from "vue";
import { clearQuestionDraft, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "../../drafts/questionDraft";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import ChatDocumentBody from "./ChatDocumentBody.vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import { documentDrawn, questionStatus } from "./cardStatus";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.question!);

const { mobile } = useDevice();

// A multi-question card takes a generic title, since no one of its asks can stand for the rest.
const title = computed(() => (card.value.questions.length > 1 ? `A few questions` : (card.value.questions[0]?.question ?? ``)));

// Picks and typed text, keyed by question index; "Other" is an ordinary option label, not parallel state.
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
    () => [card.value.requestId, card.value.status] as const,
    ([requestId, status]) => {
        if (status !== `pending`) {
            clearQuestionDraft(requestId);
            return;
        }
        // Normalizes the stored draft to picks the current card accepts (questionDraft.normalize).
        const draft = readQuestionDraft(requestId, card.value.questions);
        selections.value = draft.selections;
        otherTexts.value = draft.otherTexts;
    },
    { immediate: true },
);

// Both refs are replaced wholesale on every edit (see toggleOption/setOther), so a shallow watch sees them all.
watch([selections, otherTexts], ([picks, texts]) => {
    if (card.value.status !== `pending`) {
        return;
    }
    writeQuestionDraft(card.value.requestId, { selections: picks, otherTexts: texts });
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

const canSubmit = computed(() => card.value.questions.every((_, index) => picksFor(index).length > 0 && !otherPending(index)));

const submitAnswers = async (): Promise<void> => {
    if (!canSubmit.value) {
        return;
    }
    const answers: Record<string, string[]> = {};
    card.value.questions.forEach((question, index) => {
        answers[question.question] = picksFor(index);
    });
    await props.reply({ kind: `question`, answers });
};

// Enter submits, Shift+Enter breaks the line; mobile Enter always inserts a newline.
const otherKeydown = (event: KeyboardEvent): void => {
    if (event.key !== `Enter` || event.isComposing || event.shiftKey || mobile.value) {
        return;
    }
    event.preventDefault();
    void submitAnswers();
};

// A decided question keeps every option, marking which were picked; a typed answer joins as an option-less row.
interface DecidedOption {
    readonly label: string;
    readonly description?: string;
    readonly picked: boolean;
}

const decidedOptions = (question: AskQuestion): DecidedOption[] => {
    const picks = card.value.answers?.[question.question] ?? [];
    const typed = picks.filter((pick) => !question.options.some((option) => option.label === pick));
    return [
        ...question.options.map((option) => ({ label: option.label, description: option.description, picked: picks.includes(option.label) })),
        ...typed.map((label) => ({ label, picked: true })),
    ];
};
</script>

<template>
    <!-- The ask wraps in full rather than truncating, so it reads as the sentence it is (ChatCard's `prose` mode). -->
    <ChatCard icon="comments" icon-class="text-link" prose :title="title" :status="questionStatus(card)">
        <!-- The write-up this turn produced that the options refer to (agent.ts attaches it); folds once already drawn elsewhere. -->
        <ChatDocumentBody
            v-if="card.document"
            :document="card.document"
            foldable
            in-card
            :open="!documentDrawn(message, card.document)"
            max-height="min(58dvh, 40rem)"
            class="chat-card-doc-bottom-rule"
        />
        <div class="chat-card-body flex flex-col gap-4">
            <div v-for="(question, index) in card.questions" :key="index" class="flex flex-col gap-1">
                <!-- Only on a multi-question card, where the header's title cannot be this ask. -->
                <span v-if="card.questions.length > 1" class="chat-card-column chat-question-title text-xs font-semibold text-content">{{
                    question.question
                }}</span>

                <template v-if="card.status === 'pending'">
                    <!-- States in words what the square marks say by shape; becomes a running count once picked. -->
                    <span v-if="question.multiSelect" class="chat-card-column text-2xs text-subtle">{{
                        pickedCount(index) > 0
                            ? t(`chat.chatQuestionCard.selected`, { index: pickedCount(index) })
                            : t(`chat.chatQuestionCard.selectAllApply`)
                    }}</span>
                    <!-- ARIA roles mirror the marks; the Other text field stays outside the group, since it is that row's payload. -->
                    <div :role="question.multiSelect ? 'group' : 'radiogroup'" :aria-label="question.question">
                        <button
                            v-for="option in question.options"
                            :key="option.label"
                            type="button"
                            :role="question.multiSelect ? 'checkbox' : 'radio'"
                            :aria-checked="isSelected(index, option.label)"
                            class="chat-option ui-row-select"
                            :class="{ 'ui-row-select-on': isSelected(index, option.label) }"
                            @click="toggleOption(question, index, option.label)"
                        >
                            <Icon
                                class="chat-option-mark text-2xs"
                                :name="markFor(question, isSelected(index, option.label))"
                                :class="isSelected(index, option.label) ? 'text-primary-500' : 'text-subtle'"
                            />
                            <!-- Muted, not subtle: the description is read before choosing, not glanced past. -->
                            <span class="flex min-w-0 flex-col gap-0.5">
                                <span class="text-xs font-medium text-content">{{ option.label }}</span>
                                <span class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                                <!-- Preformatted mock-up (ASCII layout, diff, config), so options are compared side by side. -->
                                <pre v-if="option.preview" class="chat-option-preview">{{ option.preview }}</pre>
                            </span>
                        </button>
                        <!-- The custom-answer field stays below the ordinary Other option. -->
                        <button
                            type="button"
                            :role="question.multiSelect ? 'checkbox' : 'radio'"
                            :aria-checked="isSelected(index, OTHER_LABEL)"
                            class="chat-option ui-row-select"
                            :class="{ 'ui-row-select-on': isSelected(index, OTHER_LABEL) }"
                            @click="toggleOption(question, index, OTHER_LABEL)"
                        >
                            <Icon
                                class="chat-option-mark text-2xs"
                                :name="markFor(question, isSelected(index, OTHER_LABEL))"
                                :class="isSelected(index, OTHER_LABEL) ? 'text-primary-500' : 'text-subtle'"
                            />
                            <span class="flex min-w-0 flex-col gap-0.5">
                                <span class="text-xs font-medium text-content">{{ t(`chat.chatQuestionCard.other`) }}</span>
                                <span class="text-2xs leading-snug text-muted">{{
                                    question.multiSelect ? t(`chat.chatQuestionCard.addAnswerInOwn`) : t(`chat.chatQuestionCard.answerInOwnWords`)
                                }}</span>
                            </span>
                        </button>
                    </div>
                    <!-- The one framed thing on the card, in the column the labels stand in. -->
                    <div v-if="isSelected(index, OTHER_LABEL)" class="chat-option-field flex flex-col gap-1">
                        <!-- Grows rather than a fixed one-line input, since answers here often run long. -->
                        <textarea
                            :ref="(el) => setOtherInput(index, el)"
                            rows="1"
                            :value="otherValue(index)"
                            @input="onOtherInput(index, $event)"
                            @keydown="otherKeydown"
                            :placeholder="t(`chat.chatQuestionCard.typeAnswer`)"
                            class="ui-field-box ui-field-sm max-h-48 resize-none overflow-y-auto leading-relaxed"
                        ></textarea>
                        <!-- Shown from the moment the row is picked, not as an error; explains the disabled Submit. -->
                        <span v-if="otherPending(index)" class="text-2xs text-subtle">{{ t(`chat.chatQuestionCard.writeAnswerToSubmit`) }}</span>
                    </div>
                </template>
                <!-- Frozen view of a decided question: no affordances and no preview, since choosing is already done. -->
                <div v-else role="list">
                    <div
                        v-for="option in decidedOptions(question)"
                        :key="option.label"
                        role="listitem"
                        class="chat-option"
                        :class="{ 'chat-option-picked': option.picked }"
                    >
                        <span class="chat-option-mark">
                            <Icon v-if="option.picked" name="check" class="text-2xs text-primary-500" />
                        </span>
                        <span class="flex min-w-0 flex-col gap-0.5">
                            <span class="text-xs font-medium" :class="option.picked ? 'text-content' : 'text-muted'">
                                <span v-if="option.picked" class="sr-only">{{ t(`chat.chatQuestionCard.chosen`) }} </span>{{ option.label }}
                            </span>
                            <!-- Rejected options keep the live card's description colour; only the label dims. -->
                            <span v-if="option.description" class="text-2xs leading-snug text-muted">{{ option.description }}</span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
        <!-- In the shared answer row, like every other card, not floating under the last option. -->
        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="!canSubmit || settling" @click="submitAnswers">{{
                t(`chat.chatQuestionCard.submit`)
            }}</ChatDecisionButton>
            <!-- Dismiss ends the turn (CardReplies.reply, afterReply); the tooltip says so before the click. -->
            <ChatDecisionButton
                tone="secondary"
                :disabled="settling"
                v-tooltip.bottom="t(`chat.words.alsoStopsTurn`)"
                @click="reply({ kind: `question`, cancelled: true })"
                >{{ t(`ui.action.dismiss`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
