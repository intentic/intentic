<!-- The AskUserQuestion card: the ask, the options, and the answer being composed. -->
<script setup lang="ts">
import { growTextarea, Icon, type IconName, useDevice } from "@intentic/ui";
import type { AskQuestion } from "@intentic/sandbox-contract";
import { type ComponentPublicInstance, computed, inject, nextTick, reactive, ref, type Ref, watch } from "vue";
import { answerStarted, clearQuestionDraft, type DraftFile, OTHER_LABEL, readQuestionDraft, writeQuestionDraft } from "../../drafts/questionDraft";
import { claimDrop, type PendingAttachment, useChatAttachments } from "../../drafts/useChatAttachments";
import ChatAttachmentStrip from "../../composer/ChatAttachmentStrip.vue";
import { PANE_VIEW } from "../../panel/useChat-view";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { uuid } from "../../../../lib/uuid";
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
const title = computed(() => (card.value.questions.length > 1 ? t(`chat.chatQuestionCard.fewQuestions`) : (card.value.questions[0]?.question ?? ``)));

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

// Files for each Other row (a screenshot of what was meant), uploaded the moment they arrive like the composer's, and
// to the same place: this conversation's own box. Without a pane around the card there is nowhere to upload them, so
// the row offers no attaching at all.
const pane = inject(PANE_VIEW, undefined);
const { reachable } = useSandbox();
const paneConnected = computed(() => pane?.connected.value === true);
const canAttach = computed(() => pane !== undefined && reachable.value && paneConnected.value);
const box = computed(() => pane?.conversation.value.box.value);
interface RowFiles {
    readonly files: Ref<PendingAttachment[]>;
    readonly staging: ReturnType<typeof useChatAttachments>;
}
const rows = new Map<number, RowFiles>();
const rowFiles = (index: number): RowFiles => {
    const known = rows.get(index);
    if (known !== undefined) {
        return known;
    }
    const files = ref<PendingAttachment[]>([]);
    const row = { files, staging: useChatAttachments({ attachments: files, reachable, connected: paneConnected, at: box }) };
    rows.set(index, row);
    return row;
};
// One per question up front: a card's questions are fixed, and the draft watch below reads every row's list.
card.value.questions.forEach((_, index) => rowFiles(index));
const filesOf = (index: number): PendingAttachment[] => rowFiles(index).files.value;
// The pickers behind each row's paperclip.
const filePickers = ref<Record<number, HTMLInputElement | undefined>>({});
const setFilePicker = (index: number, el: Element | ComponentPublicInstance | null): void => {
    filePickers.value[index] = el instanceof HTMLInputElement ? el : undefined;
};
// Pasted into the row's field: files join its answer, text pastes as text (the staging leaves those events alone).
const onOtherPaste = (index: number, event: ClipboardEvent): void => {
    if (canAttach.value) {
        rowFiles(index).staging.onPaste(event);
    }
};
// Dropped on the row: taken here, and claimed so the pane around the card does not stage the same files in its composer.
const onOtherDrop = (index: number, event: DragEvent): void => {
    if (!canAttach.value) {
        return;
    }
    rowFiles(index).staging.onDrop(event);
    claimDrop(event);
};
const removeFile = (index: number, file: PendingAttachment): void => rowFiles(index).staging.remove(file);
// What the draft keeps: only files that finished uploading, since an upload does not outlive the page that started it.
const draftFiles = (): Record<number, DraftFile[]> =>
    Object.fromEntries(
        [...rows.entries()]
            .map(
                ([index, row]) =>
                    [index, row.files.value.filter((file) => file.status === `done`).map(({ name, path }) => ({ name, path }))] as const,
            )
            .filter(([, files]) => files.length > 0),
    );
// Restored from a draft: already on disk, so drawn by path, removable like any other.
const restoreFiles = (stored: Record<number, readonly DraftFile[]>): void => {
    for (const [index, files] of Object.entries(stored)) {
        rowFiles(Number(index)).files.value = files.map(({ name, path }) =>
            reactive<PendingAttachment>({ id: uuid(), name, path, status: `done`, progress: 1 }),
        );
    }
};
// Every row's file list as one value, so a finished upload or a removal reaches the draft like a keystroke does.
const fileState = computed(() => [...rows.values()].map((row) => row.files.value.map((file) => `${file.path}:${file.status}`).join(`|`)).join(`#`));

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
        restoreFiles(draft.otherFiles ?? {});
    },
    { immediate: true },
);

// Both refs are replaced wholesale on every edit (see toggleOption/setOther), so a shallow watch sees them all.
watch([selections, otherTexts, fileState], ([picks, texts]) => {
    if (card.value.status !== `pending`) {
        return;
    }
    writeQuestionDraft(card.value.requestId, { selections: picks, otherTexts: texts, otherFiles: draftFiles() });
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

// The row's files that are on disk; one still uploading or failed holds Submit back instead (filesSettled).
const landedFiles = (index: number): PendingAttachment[] => filesOf(index).filter((file) => file.status === `done`);
const filesSettled = (index: number): boolean => filesOf(index).every((file) => file.status === `done`);

// Other picked but blank counts as unfinished, blocking Submit rather than being dropped silently; a file alone is an
// answer, the words being optional beside a screenshot.
const otherPending = (index: number): boolean =>
    isSelected(index, OTHER_LABEL) && otherValue(index).trim().length === 0 && filesOf(index).length === 0;

// What an Other row with files and no words answers with, so the pick is never blank.
const FILES_ONLY_ANSWER = `(see the attached file)`;

// Resolves picks to answer values, swapping the Other sentinel for its typed text.
const picksFor = (index: number): string[] =>
    (selections.value[index] ?? []).flatMap((label) => {
        if (label !== OTHER_LABEL) {
            return [label];
        }
        const typed = otherValue(index).trim();
        return typed.length > 0 ? [typed] : landedFiles(index).length > 0 ? [FILES_ONLY_ANSWER] : [];
    });

// The files an answer carries: only an Other row's, and only while Other is picked.
const filesFor = (index: number): string[] => (isSelected(index, OTHER_LABEL) ? landedFiles(index).map((file) => file.path) : []);

const canSubmit = computed(() =>
    card.value.questions.every(
        (_, index) => picksFor(index).length > 0 && !otherPending(index) && (!isSelected(index, OTHER_LABEL) || filesSettled(index)),
    ),
);

const submitAnswers = async (): Promise<void> => {
    if (!canSubmit.value) {
        return;
    }
    const answers: Record<string, string[]> = {};
    const attachments: Record<string, string[]> = {};
    card.value.questions.forEach((question, index) => {
        answers[question.question] = picksFor(index);
        const files = filesFor(index);
        if (files.length > 0) {
            attachments[question.question] = files;
        }
    });
    await props.reply({ kind: `question`, answers, ...(Object.keys(attachments).length > 0 ? { attachments } : {}) });
};

// Dismiss ends the turn and drops whatever was picked, so with an answer under way it asks once first; picking again
// takes the question back off the table.
const confirmingDismiss = ref(false);
watch([selections, otherTexts, fileState], () => (confirmingDismiss.value = false));
const dismiss = async (): Promise<void> => {
    if (!confirmingDismiss.value && answerStarted({ selections: selections.value, otherTexts: otherTexts.value, otherFiles: draftFiles() })) {
        confirmingDismiss.value = true;
        return;
    }
    confirmingDismiss.value = false;
    await props.reply({ kind: `question`, cancelled: true });
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

// The files that went with a decided answer, drawn as a sent prompt's are.
const decidedFiles = (question: AskQuestion): { name: string; path: string }[] =>
    (card.value.attachments?.[question.question] ?? []).map((path) => ({ name: path.split(`/`).at(-1) ?? path, path }));
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
                    <!-- Takes files dropped on it for this answer, ahead of the pane's composer (onOtherDrop). -->
                    <div
                        v-if="isSelected(index, OTHER_LABEL)"
                        class="chat-option-field flex flex-col gap-1"
                        @dragover.prevent
                        @drop.prevent="onOtherDrop(index, $event)"
                    >
                        <div class="flex items-start gap-1">
                            <!-- Grows rather than a fixed one-line input, since answers here often run long. -->
                            <textarea
                                :ref="(el) => setOtherInput(index, el)"
                                rows="1"
                                :value="otherValue(index)"
                                @input="onOtherInput(index, $event)"
                                @keydown="otherKeydown"
                                @paste="onOtherPaste(index, $event)"
                                :placeholder="t(`chat.chatQuestionCard.typeAnswer`)"
                                class="ui-field-box ui-field-sm max-h-48 min-w-0 flex-1 resize-none overflow-y-auto leading-relaxed"
                            ></textarea>
                            <!-- A screenshot says what words struggle to; the picker is the only road on a phone. -->
                            <template v-if="canAttach">
                                <button
                                    type="button"
                                    class="composer-ghost h-8 w-8 shrink-0"
                                    v-tooltip.top="t(`chat.chatQuestionCard.attachFiles`)"
                                    :aria-label="t(`chat.chatQuestionCard.attachFiles`)"
                                    @click="filePickers[index]?.click()"
                                >
                                    <Icon name="paperclip" class="text-xs" />
                                </button>
                                <input
                                    :ref="(el) => setFilePicker(index, el)"
                                    type="file"
                                    multiple
                                    class="hidden"
                                    tabindex="-1"
                                    aria-hidden="true"
                                    @change="rowFiles(index).staging.onPick"
                                />
                            </template>
                        </div>
                        <ChatAttachmentStrip
                            v-if="filesOf(index).length > 0"
                            :attachments="filesOf(index)"
                            staged
                            class="flex-wrap pt-1"
                            @remove="(file) => removeFile(index, file)"
                        />
                        <!-- Shown from the moment the row is picked, not as an error; explains the disabled Submit. -->
                        <span v-if="otherPending(index)" class="text-2xs text-subtle">{{ t(`chat.chatQuestionCard.writeAnswerToSubmit`) }}</span>
                    </div>
                </template>
                <!-- Frozen view of a decided question: no affordances and no preview, since choosing is already done. -->
                <template v-else>
                    <div role="list">
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
                    <!-- The files that went with the answer, outside the list since they are not options. -->
                    <ChatAttachmentStrip
                        v-if="decidedFiles(question).length > 0"
                        :attachments="decidedFiles(question)"
                        class="chat-card-column flex-wrap pt-1"
                    />
                </template>
            </div>
        </div>
        <!-- In the shared answer row, like every other card, not floating under the last option. -->
        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="!canSubmit || settling" @click="submitAnswers">{{
                t(`chat.chatQuestionCard.submit`)
            }}</ChatDecisionButton>
            <!-- Dismiss ends the turn (CardReplies.reply, afterReply); the tooltip says so before the click, and with an answer picked it asks first. -->
            <template v-if="confirmingDismiss">
                <span class="text-2xs text-warning" role="alert">{{ t(`chat.chatQuestionCard.dismissDropsAnswer`) }}</span>
                <ChatDecisionButton tone="secondary" :disabled="settling" @click="dismiss">{{
                    t(`chat.chatQuestionCard.dismissAnyway`)
                }}</ChatDecisionButton>
                <ChatDecisionButton tone="secondary" :disabled="settling" @click="confirmingDismiss = false">{{
                    t(`chat.chatQuestionCard.keepAnswer`)
                }}</ChatDecisionButton>
            </template>
            <ChatDecisionButton v-else tone="secondary" :disabled="settling" v-tooltip.bottom="t(`chat.words.stopsTurn`)" @click="dismiss">{{
                t(`ui.action.dismiss`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
