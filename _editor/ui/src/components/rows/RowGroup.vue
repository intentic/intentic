<!-- Grouped-list section: an optional uppercase label (with `#actions`) above one bordered surface of hairline-divided rows. -->
<script setup lang="ts">
import { computed } from "vue";
import { ui } from "../../lib/ui.js";
import { useDialogGround } from "../overlays/dialogGround.js";
import { provideRowDensity, provideRowFlushInline, type RowDensity } from "./row.js";

// Names the group's subject when the label alone is ambiguous; sits inline with the label since a
// reader who misidentifies the subject has already misread every row below it.
// Drops the surface, for a group already sitting on one (e.g. inside a <Card>); a border between two
// identical `bg-card` surfaces reads as decoration, not structure.
// Replaces the text label for a group drawn as a loading skeleton, whose heading is a bar like the rows under it.
// Drops the hairlines between rows, for a list whose rows are each their own entry (mark, name, spacing)
// rather than one continuous list.
// A group is a list, and a list is `compact`; that is the default and the whole standard. `comfortable`
// remains <Row>'s own fallback outside a group (a card masthead outranking the rows under it). Override
// only as an argued exception; `_tools/checks/row-tiers.mjs` refuses a group that merely restates the default.
// The header scrolls with its rows: a group header cannot pin, because this band carries no fill (bg-canvas
// here reads as a dark box against the card below on the sanctum skin) and a transparent pinned band lets
// the rows sliding under it show through its own text.
const { density = `compact`, flat } = defineProps<{
    label?: string;
    caption?: string;
    flat?: boolean;
    undivided?: boolean;
    /** Equal heights for simple settings rows on desktop. Keep off groups with drawers or below-row content. */
    equalRows?: boolean;
    /** Leave alone: a group is a list and a list is `compact`. See the note above before overriding. */
    density?: RowDensity;
}>();

provideRowDensity(computed(() => density));

// On a dialog the group is its rows and their hairlines: the dialog is already the card (dialogGround.ts).
const onDialog = useDialogGround();
const surfaced = computed(() => flat !== true && !onDialog);
provideRowFlushInline(onDialog);
</script>

<template>
    <section>
        <div
            v-if="label !== undefined || $slots[`label`] || $slots[`info`] || $slots[`actions`]"
            :class="[`mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1`, onDialog ? `` : `px-1`]"
        >
            <slot name="label"
                ><span v-if="label !== undefined" :class="ui.sectionLabel()">{{ label }}</span></slot
            >
            <!-- Info controls stay attached to the group label. -->
            <slot name="info" />
            <span v-if="caption !== undefined" class="min-w-0 text-2xs text-subtle">{{ caption }}</span>
            <div v-if="$slots[`actions`]" class="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                <slot name="actions" />
            </div>
        </div>
        <!-- Something about the whole group that is none of its rows (a failing branch's incident card), drawn on its own
             between the label and the rows, so it cannot be read as one more row of the list. -->
        <div v-if="$slots[`lead`]" class="mb-3 flex flex-col gap-3">
            <slot name="lead" />
        </div>
        <!-- Equal rows: each child stretches to the tallest and centres what it holds by `align-content`, which a <Row> (a
             wrapping flex line) and a plain block child (a note, a skeleton) both answer, without being made a column. The one
             column is `minmax(0,1fr)`, not the implicit `auto`, so a row's widest control can never widen the card past its
             pane: it wraps inside the row instead, as it would in a plain block group. -->
        <div
            :class="[
                undivided === true ? `` : `divide-y divide-line-subtle`,
                surfaced ? `overflow-hidden rounded-xl bg-card shadow-sm` : ``,
                equalRows ? `grid grid-cols-[minmax(0,1fr)] md:auto-rows-fr *:content-center` : ``,
            ]"
        >
            <slot />
        </div>
    </section>
</template>
