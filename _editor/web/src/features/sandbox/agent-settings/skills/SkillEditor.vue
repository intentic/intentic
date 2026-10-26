<script setup lang="ts">
import { SKILL_DESCRIPTION_MAX, type SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { Button, Icon, MarkdownDocument, ProseField, useDevice } from "@intentic/ui";
import { computed, ref, useId } from "vue";
import { useT } from "@intentic/ui/i18n";

// A skill written where it is read: the trigger line and the instructions in the type they are read in, with no field
// boxes. A quiet label on the left and the value on the right, which is also where it changes: at rest it reads as
// text, and a hover wash says it can be typed into. The name is not asked here: a saved skill's is frozen (it is the
// invocation key and the directory) and its row already says it, and a new one is named in the head of the row it will
// become (<SkillDraftRow>), which hands it in as `name` and is told where to put the caret when it is missing.

const t = useT();

const {
    skill,
    name = ``,
    taken = [],
    disabled = false,
    saving = false,
    error,
} = defineProps<{
    /** The skill being rewritten, name and text as stored. Absent means writing a new one. */
    skill?: SkillDraft;
    /** A new skill's name as typed in its row's head; ignored for a rewrite, which keeps the stored one. */
    name?: string;
    /** Names already in the list. Saving is an upsert by name, so a new skill named like one of these would replace it. */
    taken?: readonly string[];
    disabled?: boolean;
    /** The save is in flight; the caller owns the request. */
    saving?: boolean;
    /** Why the last save failed, said beside the button that sent it. */
    error?: string | undefined;
}>();

const emit = defineEmits<{ save: [SkillDraft]; cancel: []; focusName: [] }>();

const creating = computed(() => skill === undefined);
// A phone writes the instructions in a source box that brings its own padding; the document adds none on top of it.
const { mobile } = useDevice();
const description = ref(skill?.description ?? ``);
const body = ref(skill?.body ?? ``);

// Trailing dashes are leftover from typing (`code-review-`), not part of the intended name.
const slug = computed(() => (skill === undefined ? name.replace(/-+$/, ``) : skill.name));

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

const ids = { description: useId(), body: useId() };
type Own = Exclude<Field, `name`>;
const hintOf = (field: Own): string => `${ids[field]}-hint`;
const problemOf = (field: Own): string => `${ids[field]}-problem`;
const describedBy = (field: Own): string => (shown(field) === undefined ? hintOf(field) : `${hintOf(field)} ${problemOf(field)}`);

const triggerBox = ref<{ field: HTMLTextAreaElement | undefined }>();
const bodyBox = ref<{ focus: () => void }>();
const focus = (field: Field): void => {
    if (field === `name`) {
        emit(`focusName`);
    } else if (field === `description`) {
        triggerBox.value?.field?.focus();
    } else {
        bodyBox.value?.focus();
    }
};

// What the head says under a new skill's name: said here, where the rule lives, and drawn there, where the name is.
const nameProblem = computed(() => (creating.value ? shown(`name`) : undefined));
defineExpose({ focus, nameProblem });

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

// Each value under its quiet label, all on one left edge: two values, one a sentence and one a document, read down a
// column better than across a label gutter that would only narrow them.
const PAIR = `flex flex-col gap-0.5`;
const LABEL = `text-xs text-subtle`;
// A value that is also where it changes: no box at rest, a wash under the pointer and while the caret is in it, pulled
// out by its own padding so its words line up with everything else in the column rather than with the wash.
const VALUE = `-mx-2 rounded-md transition-colors hover:bg-content/5 focus-within:bg-content/5`;
</script>

<template>
    <!-- Ctrl/Cmd+Enter or +S saves from any value, the same chords the app's other documents answer to. -->
    <div
        class="flex flex-col gap-4"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
        @keydown.ctrl.s.prevent="save"
        @keydown.meta.s.prevent="save"
    >
        <!-- The value most likely to be typed carelessly, and the only one whose carelessness is invisible afterwards, so
             what the agent does with it is said while a new one is written. -->
        <div :class="PAIR">
            <label :for="ids.description" :class="LABEL">{{ t(`sandbox.skillForm.toUse`) }}</label>
            <ProseField
                :id="ids.description"
                ref="triggerBox"
                v-model="description"
                :placeholder="example(t(`sandbox.skillForm.useUserAsksTo`))"
                :aria-describedby="describedBy(`description`)"
                :aria-invalid="shown(`description`) !== undefined"
                :disabled="disabled"
                :class="VALUE"
            />
            <!-- On a rewrite only to a screen reader: a line that appeared on focus would push the instructions down under the caret. -->
            <p :id="hintOf(`description`)" class="text-2xs text-subtle" :class="creating ? `` : `sr-only`">
                {{ t(`sandbox.skillForm.agentReadsEveryTurn`) }}
            </p>
            <p v-if="shown(`description`) !== undefined" :id="problemOf(`description`)" class="flex items-center gap-1.5 text-xs text-danger">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`description`) }}
            </p>
        </div>

        <div :class="PAIR">
            <span :class="LABEL">{{ t(`sandbox.words.instructions`) }}</span>
            <p :id="hintOf(`body`)" class="text-2xs text-subtle" :class="creating ? `` : `sr-only`">{{ t(`sandbox.skillForm.whatAgentDoesOnce`) }}</p>
            <!-- No Write/Preview toggle: markup shows only in the block holding the caret. -->
            <div :aria-describedby="describedBy(`body`)" style="--prose-measure: 76ch">
                <MarkdownDocument
                    ref="bodyBox"
                    v-model="body"
                    :editable="!disabled"
                    save="none"
                    :label="t(`sandbox.skillForm.whatSkillShouldDo`)"
                    :placeholder="example(t(`sandbox.skillForm.readMergedPullRequests`))"
                    class="min-h-28"
                    :class="mobile ? `` : [VALUE, `px-2 py-1`]"
                />
            </div>
            <p v-if="shown(`body`) !== undefined" :id="problemOf(`body`)" class="flex items-center gap-1.5 text-xs text-danger">
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
