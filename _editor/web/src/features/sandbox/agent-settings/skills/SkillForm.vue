<script setup lang="ts">
import type { SkillDraft } from "@intentic/api-contract";
import { Button, MarkdownDocument, ProseField, ui } from "@intentic/ui";
import { computed, ref } from "vue";

// Name, description and body, in the order the model reads them. Description is emphasized: the agent reads it
// every turn to decide whether to open the skill, and a vague one is silently never picked. Name is asked first
// and frozen once saved — it's the invocation key and directory, and editing it would create a second skill.

const { skill, disabled = false } = defineProps<{
    /** The skill being rewritten, name and text as stored. Absent means writing a new one. */
    skill?: SkillDraft;
    disabled?: boolean;
}>();

const emit = defineEmits<{ save: [SkillDraft]; cancel: [] }>();

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

// Names the missing field, in the order the boxes sit, so fixing what it names always moves you forward.
const missing = computed<string | undefined>(() => {
    if (name.value.replace(/-+$/, ``) === ``) {
        return `Give it a name.`;
    }
    if (description.value.trim() === ``) {
        return `Say when the agent should reach for it: this is the line it reads to decide.`;
    }
    if (body.value.trim() === ``) {
        return `Write what it should do.`;
    }
    return undefined;
});

const save = (): void => {
    if (missing.value !== undefined) {
        return;
    }
    // Trailing dashes are leftover from typing (`code-review-`), not part of the intended name.
    emit(`save`, { name: name.value.replace(/-+$/, ``), description: description.value.trim(), body: body.value.trim() });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">Called</span>
            <input
                :value="name"
                type="text"
                placeholder="release-notes"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                aria-label="Skill name"
                :disabled="disabled || skill !== undefined"
                :class="ui.inputSm(`font-mono`)"
                @input="onName"
            />
            <p v-if="skill !== undefined" class="text-2xs text-subtle">
                A skill's name is how the agent invokes it, so it can't change. Add a new one and delete this if you want it called something else.
            </p>
            <p v-else class="text-2xs text-subtle">Lowercase letters, numbers and dashes: it's how the agent invokes it.</p>
        </div>

        <!-- The field most likely to be typed carelessly, and the only one whose carelessness is invisible afterward. -->
        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">When to use it</span>
            <div class="ui-field-shell px-0.5 py-1" :class="{ 'opacity-50': disabled }">
                <ProseField
                    v-model="description"
                    placeholder="Use when the user asks to draft release notes or a changelog entry for a version."
                    aria-label="When to use this skill"
                    :disabled="disabled"
                    class="min-h-8"
                />
            </div>
            <p class="text-2xs text-subtle">
                The agent reads this every turn to decide whether to open the skill. Name the words it should trigger on.
            </p>
        </div>

        <div class="flex flex-col gap-1.5">
            <span :class="ui.sectionLabel(`text-2xs`)">What it should do</span>
            <!--
                No Write/Preview toggle: markup shows only in the block holding the caret. save="none" since the form's own
                button commits it, not the document.
            -->
            <div class="ui-field-shell p-3" :class="{ 'opacity-50': disabled }" style="--prose-measure: 76ch">
                <MarkdownDocument
                    v-model="body"
                    :editable="!disabled"
                    save="none"
                    label="What this skill should do"
                    placeholder="Markdown. Steps, commands, the format to follow, what to avoid."
                    class="min-h-32"
                />
            </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
                size="small"
                :label="skill === undefined ? `Add skill` : `Save changes`"
                :disabled="missing !== undefined || disabled"
                @click="save"
            />
            <Button size="small" text label="Cancel" @click="emit(`cancel`)" />
            <span v-if="missing !== undefined" class="text-2xs text-subtle">{{ missing }}</span>
        </div>
    </div>
</template>
