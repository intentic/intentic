<script setup lang="ts">
import { SKILL_DESCRIPTION_MAX, type SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { Button, Icon, MarkdownDocument, ProseField, useDevice } from "@intentic/ui";
import { computed, ref, useId } from "vue";
import { useT } from "@intentic/ui/i18n";

// Two looks, by what the reader is doing. Rewriting a saved skill is editing where it is read: the trigger line and the
// instructions in the type they are read in, no field boxes, a hover wash saying they can be typed into. Its name is
// not asked: it is frozen (the invocation key and the directory) and the row already says it.
// Writing a new one is filling in blanks, and a blank has to look like one: every field is a labelled, framed box, with
// the label strongest, the hint under it quieter, and the example inside the frame, so an example never passes for a
// value and the form scans as three questions top to bottom. The name is the first of them; the row's head shows it as typed.

const t = useT();

const {
    skill,
    taken = [],
    disabled = false,
    saving = false,
    error,
} = defineProps<{
    /** The skill being rewritten, name and text as stored. Absent means writing a new one. */
    skill?: SkillDraft;
    /** Names already in the list. Saving is an upsert by name, so a new skill named like one of these would replace it. */
    taken?: readonly string[];
    disabled?: boolean;
    /** The save is in flight; the caller owns the request. */
    saving?: boolean;
    /** Why the last save failed, said beside the button that sent it. */
    error?: string | undefined;
}>();

const emit = defineEmits<{ save: [SkillDraft]; cancel: [] }>();

/** A new skill's name as typed, shared with the row's head that shows it; ignored for a rewrite, which keeps the stored one. */
const name = defineModel<string>(`name`, { default: `` });
// Restricts to what a slug can hold (the name becomes a directory), enforced while typing rather than on save.
const onName = (event: Event): void => {
    // SAFETY: bound only on the name <input> below, so the event's target is that input.
    const box = event.target as HTMLInputElement;
    const typed = box.value.toLowerCase().replace(/[^a-z0-9-]/g, `-`);
    box.value = typed;
    name.value = typed;
};

const creating = computed(() => skill === undefined);
// A phone writes the instructions in a source box that brings its own padding; the document adds none on top of it.
const { mobile } = useDevice();
const description = ref(skill?.description ?? ``);
const body = ref(skill?.body ?? ``);

// Trailing dashes are leftover from typing (`code-review-`), not part of the intended name.
const slug = computed(() => (skill === undefined ? name.value.replace(/-+$/, ``) : skill.name));

// One problem per field, or none. The save button stays pressable: a press on an incomplete skill says what is missing
// under the value that needs it and puts the caret there, rather than a dimmed button that can't be asked why. In the
// order the values sit, so the first problem named is always the one nearest the top.
const FIELDS = [`name`, `description`, `body`] as const;
type Field = (typeof FIELDS)[number];
const nameTaken = computed(() => creating.value && taken.includes(slug.value));
const tooLong = computed(() => description.value.trim().length > SKILL_DESCRIPTION_MAX);
const problems = computed<Record<Field, string | undefined>>(() => ({
    name:
        slug.value === ``
            ? t(`sandbox.skillForm.giveItName`)
            : nameTaken.value
              ? t(`sandbox.skillForm.alreadySkillCalled`, { name: slug.value })
              : undefined,
    description:
        description.value.trim() === ``
            ? t(`sandbox.skillForm.sayWhenToReach`)
            : tooLong.value
              ? t(`sandbox.skillForm.keepItUnder`, { max: SKILL_DESCRIPTION_MAX })
              : undefined,
    body: body.value.trim() === `` ? t(`sandbox.skillForm.writeWhatItDoes`) : undefined,
}));
// Missing values are said only after a press; a taken name or an over-long trigger as it happens, since typing caused it.
const tried = ref(false);
const shown = (field: Field): string | undefined => {
    const typed = (field === `name` && nameTaken.value) || (field === `description` && tooLong.value);
    return tried.value || typed ? problems.value[field] : undefined;
};

// A rewrite with nothing changed has nothing to save; a new skill always has, and a press explains what is missing.
const dirty = computed(
    () => skill === undefined || description.value.trim() !== skill.description.trim() || body.value.trim() !== skill.body.trim(),
);

const ids = { name: useId(), description: useId(), body: useId() };
const hintOf = (field: Field): string => `${ids[field]}-hint`;
const problemOf = (field: Field): string => `${ids[field]}-problem`;
const describedBy = (field: Field): string => (shown(field) === undefined ? hintOf(field) : `${hintOf(field)} ${problemOf(field)}`);

const nameBox = ref<HTMLInputElement>();
const triggerBox = ref<{ field: HTMLTextAreaElement | undefined }>();
const bodyBox = ref<{ focus: () => void }>();
const focus = (field: Field): void => {
    if (field === `name`) {
        nameBox.value?.focus();
    } else if (field === `description`) {
        triggerBox.value?.field?.focus();
    } else {
        bodyBox.value?.focus();
    }
};

defineExpose({ focus });

const save = (): void => {
    if (disabled || saving || !dirty.value) {
        return;
    }
    const first = FIELDS.find((field) => problems.value[field] !== undefined);
    if (first !== undefined) {
        tried.value = true;
        focus(first);
        return;
    }
    emit(`save`, { name: slug.value, description: description.value.trim(), body: body.value.trim() });
};

const example = (text: string): string => t(`sandbox.skillForm.forExample`, { example: text });

// Each value under its label, all on one left edge: a sentence and a document read down a column better than across a
// label gutter that would only narrow them.
const PAIR = `flex flex-col gap-1`;
// A rewrite labels quietly, like every other open row's facts; a new skill's labels are the questions being asked.
const LABEL = computed(() => (creating.value ? `text-sm font-medium text-content` : `text-xs text-subtle`));
// The hint answers "how do I write this", so it sits between the question and the box, and reads below the label.
const HINT = `text-xs text-muted`;
// A rewrite's value is also where it changes: no box at rest, a wash under the pointer and while the caret is in it,
// pulled out by its own padding so its words line up with everything else in the column rather than with the wash.
const WASH = `-mx-2 rounded-md transition-colors hover:bg-content/5 focus-within:bg-content/5`;
// A new skill's value is a blank to fill: the field frame, a step of room under the hint.
const FRAME = `ui-field-shell mt-1`;
const PROBLEM = `flex items-center gap-1.5 text-xs text-danger`;
</script>

<template>
    <!-- Ctrl/Cmd+Enter or +S saves from any value, the same chords the app's other documents answer to. -->
    <div
        class="flex flex-col"
        :class="creating ? `gap-6` : `gap-4`"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
        @keydown.ctrl.s.prevent="save"
        @keydown.meta.s.prevent="save"
    >
        <!-- A new skill's name, first because the rest is written about it. In the type it is invoked by. -->
        <div v-if="creating" :class="PAIR">
            <label :for="ids.name" :class="LABEL">{{ t(`shared.name`) }}</label>
            <p :id="hintOf(`name`)" :class="HINT">{{ t(`sandbox.skillForm.lowercaseLettersNumbersDashes`) }}</p>
            <input
                :id="ids.name"
                ref="nameBox"
                :value="name"
                type="text"
                :placeholder="example(`release-notes`)"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                :aria-describedby="describedBy(`name`)"
                :aria-invalid="shown(`name`) !== undefined"
                :disabled="disabled"
                class="ui-field-box mt-1 w-full max-w-80 font-mono"
                :class="shown(`name`) === undefined ? `` : `ui-field-error-box`"
                @input="onName"
                @keydown.enter.exact.prevent="focus(`description`)"
            />
            <p v-if="shown(`name`) !== undefined" :id="problemOf(`name`)" :class="PROBLEM">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`name`) }}
            </p>
        </div>

        <!-- The value most likely to be typed carelessly, and the only one whose carelessness is invisible afterwards, so
             what the agent does with it is said while a new one is written. -->
        <div :class="PAIR">
            <label :for="ids.description" :class="LABEL">{{ t(`sandbox.skillForm.toUse`) }}</label>
            <!-- On a rewrite only to a screen reader: a line that appeared on focus would push the instructions down under the caret. -->
            <p :id="hintOf(`description`)" :class="creating ? HINT : `sr-only`">
                {{ t(`sandbox.skillForm.agentReadsEveryTurn`) }}
            </p>
            <ProseField
                :id="ids.description"
                ref="triggerBox"
                v-model="description"
                :placeholder="example(t(`sandbox.skillForm.useUserAsksTo`))"
                :aria-describedby="describedBy(`description`)"
                :aria-invalid="shown(`description`) !== undefined"
                :disabled="disabled"
                :class="creating ? [FRAME, shown(`description`) === undefined ? `` : `ui-field-error-box`] : WASH"
            />
            <p v-if="shown(`description`) !== undefined" :id="problemOf(`description`)" :class="PROBLEM">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`description`) }}
            </p>
        </div>

        <div :class="PAIR">
            <span :class="LABEL">{{ t(`sandbox.words.instructions`) }}</span>
            <p :id="hintOf(`body`)" :class="creating ? HINT : `sr-only`">{{ t(`sandbox.skillForm.whatAgentDoesOnce`) }}</p>
            <!-- No Write/Preview toggle: markup shows only in the block holding the caret. A phone writes in a source box
                 that brings its own frame and padding, so neither look adds one there. -->
            <div
                :aria-describedby="describedBy(`body`)"
                style="--prose-measure: 76ch"
                :class="creating && !mobile ? [FRAME, `cursor-text px-1`, shown(`body`) === undefined ? `` : `ui-field-error-box`] : ``"
                @click.self="bodyBox?.focus()"
            >
                <MarkdownDocument
                    ref="bodyBox"
                    v-model="body"
                    :editable="!disabled"
                    save="none"
                    :label="t(`sandbox.skillForm.whatSkillShouldDo`)"
                    :placeholder="example(t(`sandbox.skillForm.readMergedPullRequests`))"
                    :class="mobile ? `min-h-28` : creating ? `min-h-40 px-2 py-1` : [`min-h-28`, WASH, `px-2 py-1`]"
                />
            </div>
            <p v-if="shown(`body`) !== undefined" :id="problemOf(`body`)" :class="PROBLEM">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`body`) }}
            </p>
        </div>

        <!-- The skill's own verbs on the left (delete), the edit's on the right, so the destructive one never sits beside Save. -->
        <div class="flex flex-wrap items-center gap-2">
            <slot name="start" />
            <span class="ml-auto min-w-0 text-2xs" :class="error === undefined ? `text-subtle` : `text-danger`">
                {{ error ?? (skill !== undefined && dirty ? t(`ui.markdownDocument.notSavedYet`) : ``) }}
            </span>
            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="emit(`cancel`)" />
            <Button
                size="small"
                :label="creating ? t(`sandbox.skillForm.addSkill`) : t(`sandbox.words.saveChanges`)"
                :disabled="disabled || !dirty"
                :loading="saving"
                @click="save"
            />
        </div>
    </div>
</template>
