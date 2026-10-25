<script setup lang="ts">
import { SKILL_DESCRIPTION_MAX, type SkillDraft } from "@intentic/sandbox-contract/schemas/settings";
import { Button, Icon, MarkdownDocument, ProseField, useDevice } from "@intentic/ui";
import { computed, onMounted, ref, useId } from "vue";
import { useT } from "@intentic/ui/i18n";

// Name, trigger and instructions, in the order the model reads them. Every field reads the same way: its label, what
// it is for, then the box, so the guidance is read before the typing starts rather than found after it. The three
// boxes share one frame and one inset, and each placeholder is an example of the same skill, marked as one, so an
// empty box never passes for a filled one. Name is asked only of a new skill: it's the invocation key and the
// directory, so it is frozen once saved, and the row being edited already says it.

const t = useT();

const {
    skill,
    taken = [],
    disabled = false,
} = defineProps<{
    /** The skill being rewritten, name and text as stored. Absent means writing a new one. */
    skill?: SkillDraft;
    /** Names already in the list. Saving is an upsert by name, so a new skill named like one of these would replace it. */
    taken?: readonly string[];
    disabled?: boolean;
}>();

const emit = defineEmits<{ save: [SkillDraft]; cancel: [] }>();

// A phone writes the instructions in a source box that brings its own padding; the shell adds none on top of it.
const { mobile } = useDevice();

const name = ref(skill?.name ?? ``);
const description = ref(skill?.description ?? ``);
const body = ref(skill?.body ?? ``);

// Restricts to what a slug can hold (the name becomes a directory), enforced while typing rather than on save.
const onName = (event: Event): void => {
    const box = event.target as HTMLInputElement;
    const slug = box.value.toLowerCase().replace(/[^a-z0-9-]/g, `-`);
    box.value = slug;
    name.value = slug;
};
// Trailing dashes are leftover from typing (`code-review-`), not part of the intended name.
const slug = computed(() => name.value.replace(/-+$/, ``));

// One problem per field, or none. The save button stays pressable: a press on an incomplete form says what is
// missing under the box that needs it and puts the caret there, rather than a dimmed button that can't be asked why.
// In the order the boxes sit, so the first problem named is always the one nearest the top.
const FIELDS = [`name`, `description`, `body`] as const;
type Field = (typeof FIELDS)[number];
const nameTaken = computed(() => skill === undefined && taken.includes(slug.value));
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
            : description.value.trim().length > SKILL_DESCRIPTION_MAX
              ? t(`sandbox.skillForm.keepItUnder`, { max: SKILL_DESCRIPTION_MAX })
              : undefined,
    body: body.value.trim() === `` ? t(`sandbox.skillForm.writeWhatItDoes`) : undefined,
}));
// Missing fields are said only after a press; a taken name or an over-long trigger as it happens, since typing caused it.
const tried = ref(false);
const shown = (field: Field): string | undefined => {
    const problem = problems.value[field];
    const typed = (field === `name` && nameTaken.value) || (field === `description` && description.value.trim().length > SKILL_DESCRIPTION_MAX);
    return tried.value || typed ? problem : undefined;
};

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

// A new skill opens on its first box: pressing "Write a skill" already said what comes next.
onMounted(() => {
    if (skill === undefined && !disabled) {
        nameBox.value?.focus();
    }
});

const save = (): void => {
    if (disabled) {
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
</script>

<template>
    <!-- Ctrl/Cmd+Enter or +S saves from any box, the same chords the app's other documents answer to. -->
    <div
        class="flex flex-col gap-5"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
        @keydown.ctrl.s.prevent="save"
        @keydown.meta.s.prevent="save"
    >
        <div v-if="skill === undefined" class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
                <label :for="ids.name" class="text-sm font-medium text-content">{{ t(`shared.name`) }}</label>
                <p :id="hintOf(`name`)" class="text-xs text-subtle">{{ t(`sandbox.skillForm.lowercaseLettersNumbersDashes`) }}</p>
            </div>
            <div
                class="ui-field-shell flex w-full max-w-80 items-center px-3 py-1.5"
                :class="{ 'ui-field-error-box': shown(`name`) !== undefined, 'opacity-50': disabled }"
            >
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
                    class="field-bare w-full min-w-0 font-mono text-sm leading-[1.7] max-md:text-base"
                    @input="onName"
                    @keydown.enter.exact.prevent="focus(`description`)"
                />
            </div>
            <p v-if="shown(`name`) !== undefined" :id="problemOf(`name`)" class="flex items-center gap-1.5 text-xs text-danger">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`name`) }}
            </p>
        </div>

        <!-- The field most likely to be typed carelessly, and the only one whose carelessness is invisible afterward. -->
        <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
                <label :for="ids.description" class="text-sm font-medium text-content">{{ t(`sandbox.skillForm.toUse`) }}</label>
                <p :id="hintOf(`description`)" class="text-xs text-subtle">{{ t(`sandbox.skillForm.agentReadsEveryTurn`) }}</p>
            </div>
            <div class="ui-field-shell px-1 py-0.5" :class="{ 'ui-field-error-box': shown(`description`) !== undefined, 'opacity-50': disabled }">
                <ProseField
                    :id="ids.description"
                    ref="triggerBox"
                    v-model="description"
                    :placeholder="example(t(`sandbox.skillForm.useUserAsksTo`))"
                    :aria-describedby="describedBy(`description`)"
                    :aria-invalid="shown(`description`) !== undefined"
                    :disabled="disabled"
                    class="[&_textarea:focus]:bg-transparent"
                />
            </div>
            <p v-if="shown(`description`) !== undefined" :id="problemOf(`description`)" class="flex items-center gap-1.5 text-xs text-danger">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`description`) }}
            </p>
        </div>

        <div class="flex flex-col gap-1.5">
            <div class="flex flex-col gap-0.5">
                <span class="text-sm font-medium text-content">{{ t(`sandbox.skillForm.whatShouldDo`) }}</span>
                <p :id="hintOf(`body`)" class="text-xs text-subtle">{{ t(`sandbox.skillForm.whatAgentDoesOnce`) }}</p>
            </div>
            <!-- No Write/Preview toggle: markup shows only in the block holding the caret. -->
            <div
                class="ui-field-shell"
                :class="{ 'px-3 py-1.5': !mobile, 'ui-field-error-box': shown(`body`) !== undefined, 'opacity-50': disabled }"
                style="--prose-measure: 76ch"
                :aria-describedby="describedBy(`body`)"
            >
                <MarkdownDocument
                    ref="bodyBox"
                    v-model="body"
                    :editable="!disabled"
                    save="none"
                    :label="t(`sandbox.skillForm.whatSkillShouldDo`)"
                    :placeholder="example(t(`sandbox.skillForm.readMergedPullRequests`))"
                    class="min-h-36"
                />
            </div>
            <p v-if="shown(`body`) !== undefined" :id="problemOf(`body`)" class="flex items-center gap-1.5 text-xs text-danger">
                <Icon name="exclamation-circle" class="shrink-0 text-2xs" aria-hidden="true" />
                {{ shown(`body`) }}
            </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <Button
                size="small"
                :label="skill === undefined ? t(`sandbox.skillForm.addSkill`) : t(`sandbox.words.saveChanges`)"
                :disabled="disabled"
                @click="save"
            />
            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="emit(`cancel`)" />
        </div>
    </div>
</template>
