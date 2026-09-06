<script setup lang="ts">
import type { SkillDraft } from "@intentic/api-contract";
import { Button, MarkdownDocument, ProseField, ui } from "@intentic/ui";
import { computed, ref } from "vue";

/* WRITING ONE SKILL: three boxes, in the order the model reads them.
 *
 * A skill is a name, a line saying when to reach for it, and the instructions themselves, and those three are not
 * equals: the model reads the middle one on EVERY turn to decide whether to open the third. So the second box is
 * the one this form makes a fuss about: its own label, its own hint, no sharing a row, because a skill with a
 * vague description is a skill that is never picked, and that failure is silent. Nothing on screen would look
 * wrong; the agent would simply never use it.
 *
 * THE NAME IS ASKED FIRST HERE, unlike the rule form which derives one. A skill's name is not a label: it is how
 * the agent invokes it and the directory it lives in, so it cannot be a footnote the user may overwrite. It is
 * also the identity a save upserts on, which is why an existing skill's name box is frozen: typing over it would
 * read as a rename and would in fact write a second skill beside the first.
 *
 * THE BODY IS THE SKILL, so it gets the room, and it is a DOCUMENT rather than a field. It has been three
 * things: a prose field (right for a sentence, wrong for a file with headings, fenced commands and lists,
 * which it set in one flat grey weight), then a coloured source field with a Preview pill beside it (honest
 * about the markup, but it answered "what will the agent read" by taking the author out of their own document
 * to look at a copy). It is now <MarkdownDocument>, where those are the same screen: the words are set as the
 * document they will be read as, and the markup shows only on the block holding the caret. It is also the
 * surface a skill is READ on one component over (SkillRow), so reading somebody's skill and writing your own
 * are no longer two different pictures of the same file. It grows with the file: a skill is never written
 * through an eight-line window. */

const { skill, disabled = false } = defineProps<{
    /** The skill being rewritten, name and text as stored. Absent ⇒ writing a new one. */
    skill?: SkillDraft;
    disabled?: boolean;
}>();

const emit = defineEmits<{ save: [SkillDraft]; cancel: [] }>();

const name = ref(skill?.name ?? ``);
const description = ref(skill?.description ?? ``);
const body = ref(skill?.body ?? ``);
// The name is the directory the skill lives in, so the box refuses what the daemon would: anything a slug cannot
// hold. Typed rather than validated on save, because a rejected save after writing three paragraphs is the worst
// moment to learn the rule.
const onName = (event: Event): void => {
    const box = event.target as HTMLInputElement;
    const slug = box.value.toLowerCase().replace(/[^a-z0-9-]/g, `-`);
    box.value = slug;
    name.value = slug;
};

/* WHY THE BUTTON IS GREY, said next to the button: the rule form's own answer to the same question. Named one at
 * a time, in the order the boxes sit, so fixing the one it names always moves you forward. */
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
    // Trailing dashes are what a name mid-typing looks like ("code-review-"), not what anyone meant to save.
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
            <!-- Two different reasons this box says what it says, and the reader is owed whichever applies. -->
            <p v-if="skill !== undefined" class="text-2xs text-subtle">
                A skill's name is how the agent invokes it, so it can't change. Add a new one and delete this if you want it called something else.
            </p>
            <p v-else class="text-2xs text-subtle">Lowercase letters, numbers and dashes: it's how the agent invokes it.</p>
        </div>

        <!-- THE LINE THAT DECIDES WHETHER ANY OF THE REST IS EVER READ. Its own section, above the body rather
             than beside the name, because it is the field most likely to be typed carelessly and the only one
             whose carelessness is invisible afterwards. -->
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
            <!-- THE SKILL, ON THE APP'S ONE MARKDOWN SURFACE, and the Write/Preview pair that used to sit above
                 this is gone. That pill existed to answer "what will the agent actually read", and it answered
                 it by taking the author out of their own document to look at a copy. Here the two are the same
                 thing: the words are set as the document they will be read as, and the markup for the block
                 holding the caret is the only markup on screen. Nothing to switch, nothing to switch back.

                 The form owns the save (Add skill / Save changes below), which is what `save="none"` says: no
                 debounce, no button of its own, no status line contradicting the one the form is about to
                 show. -->
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
