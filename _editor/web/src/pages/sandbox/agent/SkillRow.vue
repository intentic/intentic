<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic-app/api-contract";
import { BrandMark, Button, CopyButton, DisclosureRow, Icon, MarkdownDocument } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import SkillForm from "./SkillForm.vue";
import type { SkillSources } from "./skillVisual";
import { skillVisual } from "./skillVisual";
import { provenanceOf } from "./skillWords";

/* ONE SKILL, on one line until asked otherwise: the extension list's row (ExtensionRow.vue), because this list
 * is read the same way and was the only one in the hub still hiding its content behind a menu.
 *
 * WHAT THIS REPLACES, and why the menu was the wrong shape. Reading a skill used to be: find the hamburger at
 * the right-hand end of the row, click it, read a two-item menu, pick "Read", then find a text Close button at
 * the bottom of what opened. Four gestures and two discoveries to see a file, and the menu's own items said
 * nothing the row didn't already imply, since "Read" is simply what opening a row IS. So the row opens itself.
 * The chevron says it can, in the column where every other expandable row in the app puts it, and the same click
 * closes it, which is also why nothing here closes on Escape: the form's Cancel discards what has been typed,
 * and a key that quietly threw away three paragraphs would be a worse trade than a second click on the row.
 *
 * "THE COLUMN WHERE EVERY OTHER EXPANDABLE ROW PUTS IT" IS <DisclosureRow> NOW, and it used not to be true: this
 * file drew `chevron-right` + `rotate-90`, the activity feed swapped two icon names, the deployments board
 * rotated a `chevron-down` 180°, and the ports list used an `(i)`. The chevron, the ARIA, the open wash and the
 * hairline under the header all come from the component; what is left here is what a skill IS.
 *
 * DELETE MOVED UNDER THE FOLD, where it now asks first. On the closed row it was one keystroke away from a
 * skill the reader may have spent an afternoon on, hidden inside a menu that gave no clue which rows even offer
 * it; here it sits beside the text it would delete, and says what it is about to remove.
 *
 * AND IT SITS UNDER BOTH VIEWS, not only the read one. It used to live inside the branch that renders somebody
 * else's skill, which meant the rows that are actually the reader's: their own skills, and every skill on a
 * persona's card: opened straight into the form and offered no way to delete at all. The one kind of skill a
 * person can delete was the one kind that never showed the button. So the strip is a sibling of the two views:
 * whichever one the row opened in, the last thing under it is the destructive action, on its own side of a
 * rule.
 *
 * READING IS THE DEFAULT AND IT IS THE DOCUMENT. A skill is markdown: headings, numbered steps, fenced
 * commands: and it used to open as a grey monospace block, i.e. as the one thing a skill is not: source to be
 * inspected. So someone else's skill renders as the document it is, on <MarkdownDocument> — the same surface
 * the reader's own skill is WRITTEN on one branch below, which is what makes reading and editing one place
 * rather than two that happen to show the same file. The Read/Source pill that used to sit above it is gone
 * with the divergence it papered over: the markup is in that surface's DOM the whole time and simply hidden
 * until a caret enters a block, so "Source" showed the same characters in a worse typeface. Taking the file
 * away with you, which is what anyone actually reached for it for, is the Copy button. */

const { skill, expanded, body, bodyError, sources, disabled } = defineProps<{
    skill: SkillSummary;
    expanded: boolean;
    /** The skill's text, once it has arrived. Undefined while the open row is still fetching it. */
    body?: string | undefined;
    bodyError?: string | undefined;
    /** What the extensions and connections say their own marks are: see skillVisual. */
    sources: SkillSources;
    /** The settings object hasn't loaded, so nothing here can be written yet. */
    disabled: boolean;
}>();

const emit = defineEmits<{
    toggle: [];
    enable: [enabled: boolean];
    save: [SkillDraft];
    remove: [];
}>();

const visual = computed(() => skillVisual(skill, sources));

// The form edits a draft, not a row: the row carries provenance the form has no business in, and the body is
// not on the row at all until it has been read.
const editing = computed<SkillDraft | undefined>(() =>
    skill.editable && body !== undefined ? { name: skill.name, description: skill.description, body } : undefined,
);

// Asked in place rather than in a dialog: a skill is a file, and the question costs less than a restore from
// somebody's memory. Closing the row drops the question; it must never be waiting when the row is opened again.
const confirmRemove = ref(false);
watch(
    () => expanded,
    () => (confirmRemove.value = false),
);
</script>

<template>
    <!-- `body="drawer"`: what opens here is a place to read and edit a file, not evidence hanging off the row's
         name, so it takes the full width. Header and drawer share the open row's one wash, so an expanded row
         reads as a single block rather than as a row that grew a panel under it. -->
    <DisclosureRow body="drawer" :open="expanded" @update:open="emit(`toggle`)">
        <template #lead="{ mark }">
            <!-- Drained and dimmed on a switched-off skill, so a brand goes quiet with the rest of the row
                 instead of being the loudest thing on the one row that is off. Sized and tiered by the
                 <RowGroup> this row is dropped into, not by this file. -->
            <BrandMark :size="mark" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
        </template>

        <template #title>
            <span class="flex min-w-0 items-center gap-2">
                <span class="shrink-0" :class="skill.enabled ? `text-content` : `text-muted`">{{ skill.name }}</span>
                <span class="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-2xs font-normal text-muted">{{ provenanceOf(skill) }}</span>
            </span>
        </template>

        <!-- The line the agent reads every turn to decide whether to open this skill, on the row for the same
             reason: it is what the row is FOR. Only while closed, open, it is stated in full a few lines below,
             and a truncated copy of text already on screen is noise. -->
        <template v-if="!expanded" #description>
            <span class="block truncate" :class="skill.description === `` ? `italic text-subtle` : ``">
                {{ skill.description === `` ? `No description, the agent rarely picks a skill without one.` : skill.description }}
            </span>
        </template>

        <!-- Never dimmed with the row: a faded control reads as unavailable, and the switch is the one thing
             on a switched-off row that still does something. Outside the disclosure's hit area, which is what
             <DisclosureRow>'s `#control` slot is for: nesting it inside would make every attempt to flip it
             expand the row instead. -->
        <template v-if="skill.switchable" #control>
            <ToggleSwitch
                class="ui-switch-sm shrink-0"
                :model-value="skill.enabled"
                :disabled="disabled"
                :aria-label="`Enable ${skill.name}`"
                @update:model-value="(value: boolean) => emit(`enable`, value)"
            />
        </template>

        <template #below>
            <p v-if="bodyError !== undefined" class="text-2xs text-danger">{{ bodyError }}</p>
            <p v-else-if="body === undefined" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-xs" />
                Reading…
            </p>
            <template v-else>
                <!-- The reader's own skill: the form IS how they read it. -->
                <SkillForm v-if="editing !== undefined" :skill="editing" :disabled="disabled" @save="emit(`save`, $event)" @cancel="emit(`toggle`)" />
                <div v-else class="flex flex-col gap-3">
                    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                        <!-- Someone else's skill states its trigger line in full: it is the half a reader is most
                             likely to be checking, and it is the half the closed row had to cut. A shipped skill is
                             allowed to declare none, and the blank is worth naming here too: it is why the agent
                             will hardly ever reach for this one, and the open row is where somebody would look. -->
                        <p class="min-w-0 flex-1 text-2xs" :class="skill.description === `` ? `italic text-subtle` : `text-muted`">
                            {{ skill.description === `` ? `No description, the agent rarely picks a skill without one.` : skill.description }}
                        </p>
                        <CopyButton :text="body" label="Copy" v-tooltip.top="'The file exactly as its author wrote it'" />
                    </div>
                    <!-- SOMEBODY ELSE'S SKILL, on the app's one markdown surface with nothing to type into. The
                         Read/Source pair that used to sit above this is gone: it existed because a rendered
                         document and its source were two different components here, and a reader who wanted to
                         see the markup had to leave the document to get it. On this surface the markup is in
                         the DOM the whole time — it is simply hidden until a caret enters a block, and there is
                         no caret here — so "Source" would have shown the same characters in a worse typeface.
                         What that toggle was actually for, taking the file away with you, is the Copy button. -->
                    <MarkdownDocument
                        :model-value="body"
                        :label="`${skill.name} instructions`"
                        class="max-h-96 overflow-auto"
                        style="--prose-measure: 76ch"
                    />
                </div>

                <!-- BELOW WHICHEVER VIEW OPENED, and below the form's own Save/Cancel when that is the view: the
                     safe actions and the one that cannot be undone do not share a row. -->
                <div v-if="skill.removable" class="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                        v-if="!confirmRemove"
                        size="small"
                        severity="danger"
                        text
                        label="Delete this skill"
                        :disabled="disabled"
                        @click="confirmRemove = true"
                    />
                    <template v-else>
                        <span class="text-2xs text-muted">Delete "{{ skill.name }}"? The agent stops being handed it.</span>
                        <Button size="small" severity="danger" label="Delete" :disabled="disabled" @click="emit(`remove`)" />
                        <Button size="small" severity="secondary" text label="Keep it" @click="confirmRemove = false" />
                    </template>
                </div>
            </template>
        </template>
    </DisclosureRow>
</template>
