<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic-app/api-contract";
import { BrandMark, CodeField, Icon, Markdown, SegmentedControl } from "@intentic/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import SkillForm from "./SkillForm.vue";
import type { SkillSources } from "./skillVisual";
import { skillVisual } from "./skillVisual";
import { provenanceOf } from "./skillWords";

/* ONE SKILL, on one line until asked otherwise — the extension list's row (ExtensionRow.vue), because this list
 * is read the same way and was the only one in the hub still hiding its content behind a menu.
 *
 * WHAT THIS REPLACES, and why the menu was the wrong shape. Reading a skill used to be: find the hamburger at
 * the right-hand end of the row, click it, read a two-item menu, pick "Read", then find a text Close button at
 * the bottom of what opened. Four gestures and two discoveries to see a file — and the menu's own items said
 * nothing the row didn't already imply, since "Read" is simply what opening a row IS. So the row opens itself.
 * The chevron says it can, in the column where every other expandable row in the app puts it, and the same click
 * closes it — which is also why nothing here closes on Escape: the form's Cancel discards what has been typed,
 * and a key that quietly threw away three paragraphs would be a worse trade than a second click on the row.
 *
 * THE SWITCH STAYS OUTSIDE THE BUTTON, and that is not a nicety: a control nested inside a <button> is invalid
 * and unusable — every attempt to flip it would expand the row instead. Same split the acceptance panel's story
 * rows make for their tick.
 *
 * DELETE MOVED UNDER THE FOLD, where it now asks first. On the closed row it was one keystroke away from a
 * skill the reader may have spent an afternoon on, hidden inside a menu that gave no clue which rows even offer
 * it; here it sits beside the text it would delete, and says what it is about to remove.
 *
 * READING IS THE DEFAULT AND IT IS RENDERED. A skill is markdown — headings, numbered steps, fenced commands —
 * and it used to open as a grey monospace block, i.e. as the one thing a skill is not: source to be inspected.
 * So someone else's skill renders as the document it is, with its raw text one pill away for whoever wants to
 * see the file exactly as its author shipped it (the memory pane's Preview/Source pair, for the same reason).
 * The reader's OWN skill opens in the form instead — for them, reading and editing are the same errand. */

const { skill, expanded, body, bodyError, sources, disabled } = defineProps<{
    skill: SkillSummary;
    expanded: boolean;
    /** The skill's text, once it has arrived. Undefined while the open row is still fetching it. */
    body?: string | undefined;
    bodyError?: string | undefined;
    /** What the extensions and connections say their own marks are — see skillVisual. */
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

const view = ref<`preview` | `source`>(`preview`);
// Asked in place rather than in a dialog — a skill is a file, and the question costs less than a restore from
// somebody's memory. Closing the row drops the question; it must never be waiting when the row is opened again.
const confirmRemove = ref(false);
watch(
    () => expanded,
    () => {
        confirmRemove.value = false;
        view.value = `preview`;
    },
);
</script>

<template>
    <!-- Header and body share one tint while open, so an expanded row reads as a single block rather than as a
         row that grew a panel under it. The extension list's wash, for the same reason it is a wash there. -->
    <div class="group" :class="expanded ? `bg-content/6` : `transition-colors hover:bg-content/4`">
        <div class="flex items-center gap-3 pl-2.5 pr-3">
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2.5 text-left"
                :aria-expanded="expanded"
                @click="emit(`toggle`)"
            >
                <Icon
                    name="chevron-right"
                    class="shrink-0 text-2xs text-subtle transition-transform group-hover:text-muted"
                    :class="expanded ? `rotate-90` : undefined"
                    aria-hidden="true"
                />
                <!-- Drained and dimmed on a switched-off skill, so a brand goes quiet with the rest of the row
                     instead of being the loudest thing on the one row that is off. -->
                <BrandMark :size="22" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
                <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-center gap-2">
                        <span class="shrink-0 text-sm font-medium" :class="skill.enabled ? `text-content` : `text-muted`">{{ skill.name }}</span>
                        <span class="shrink-0 rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{ provenanceOf(skill) }}</span>
                    </span>
                    <!-- The line the agent reads every turn to decide whether to open this skill, on the row for
                         the same reason: it is what the row is FOR. Only while closed — open, it is stated in
                         full a few lines below, and a truncated copy of text already on screen is noise. -->
                    <span
                        v-if="!expanded"
                        class="block truncate pt-0.5 text-2xs"
                        :class="skill.description === `` ? `italic text-subtle` : `text-muted`"
                    >
                        {{ skill.description === `` ? `No description — the agent rarely picks a skill without one.` : skill.description }}
                    </span>
                </span>
            </button>
            <!-- Never dimmed with the row: a faded control reads as unavailable, and the switch is the one thing
                 on a switched-off row that still does something. -->
            <ToggleSwitch
                v-if="skill.switchable"
                class="ui-switch-sm shrink-0"
                :model-value="skill.enabled"
                :disabled="disabled"
                :aria-label="`Enable ${skill.name}`"
                @update:model-value="(value: boolean) => emit(`enable`, value)"
            />
        </div>

        <!-- Indented to the name's column, so it reads as belonging to the row above rather than as a new
             section. -->
        <div v-if="expanded" class="border-t border-line py-3 pl-9 pr-3">
            <p v-if="bodyError !== undefined" class="text-2xs text-danger">{{ bodyError }}</p>
            <p v-else-if="body === undefined" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="spinner" class="animate-spin text-xs" />
                Reading…
            </p>
            <!-- The reader's own skill: the form IS how they read it. -->
            <SkillForm
                v-else-if="editing !== undefined"
                :skill="editing"
                :disabled="disabled"
                @save="emit(`save`, $event)"
                @cancel="emit(`toggle`)"
            />
            <div v-else class="flex flex-col gap-3">
                <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <!-- Someone else's skill states its trigger line in full: it is the half a reader is most
                         likely to be checking, and it is the half the closed row had to cut. A shipped skill is
                         allowed to declare none, and the blank is worth naming here too — it is why the agent
                         will hardly ever reach for this one, and the open row is where somebody would look. -->
                    <p class="min-w-0 flex-1 text-2xs" :class="skill.description === `` ? `italic text-subtle` : `text-muted`">
                        {{ skill.description === `` ? `No description — the agent rarely picks a skill without one.` : skill.description }}
                    </p>
                    <SegmentedControl
                        v-model="view"
                        size="xs"
                        class="shrink-0"
                        :options="[
                            { label: `Read`, value: `preview` },
                            { label: `Source`, value: `source`, title: `The file exactly as its author wrote it` },
                        ]"
                    />
                </div>
                <Markdown v-if="view === `preview`" :source="body" style="--prose-measure: 76ch" />
                <!-- Markdown's own colours, read-only: this is somebody else's file, and editing it here would
                     be undone the next time the thing that ships it reconciles. -->
                <CodeField
                    v-else
                    :model-value="body"
                    lang="markdown"
                    readonly
                    :aria-label="`${skill.name} source`"
                    class="max-h-96 overflow-auto rounded-md border border-line bg-canvas p-2.5"
                />
                <div v-if="skill.removable" class="flex items-center gap-3 border-t border-line/60 pt-3">
                    <Button v-if="!confirmRemove" size="small" severity="danger" text label="Delete this skill" @click="confirmRemove = true" />
                    <template v-else>
                        <span class="text-2xs text-muted">Delete “{{ skill.name }}”? The agent stops being handed it.</span>
                        <Button size="small" severity="danger" label="Delete" @click="emit(`remove`)" />
                        <Button size="small" severity="secondary" text label="Keep it" @click="confirmRemove = false" />
                    </template>
                </div>
            </div>
        </div>
    </div>
</template>
