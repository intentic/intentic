<!-- Grouped-list section: the one section header (<SectionHeader>) above one card of hairline-divided rows. -->
<script setup lang="ts">
import { computed } from "vue";
import type { SectionLabelVariants } from "../../lib/ui.js";
import { SurfaceGround, useSurfaceGround } from "../overlays/surfaceGround.js";
import { provideRowDensity, provideRowFlushInline, ROW_TIERS, type RowDensity } from "./row.js";
import SectionHeader from "./SectionHeader.vue";

// Replaces the text label for a group drawn as a loading skeleton, whose heading is a bar like the rows under it.
// Drops the hairlines between rows, for a list whose rows are each their own entry (mark, name, spacing)
// rather than one continuous list.
// A group is a list, and a list is `compact`; that is the default and the whole standard. `comfortable`
// remains <Row>'s own fallback outside a group (a card masthead outranking the rows under it). Override
// only as an argued exception; `_tools/checks/row-tiers.mjs` refuses a group that merely restates the default.
// The header scrolls with its rows: a group header cannot pin, because this band carries no fill (bg-canvas
// here reads as a dark box against the card below on the sanctum skin) and a transparent pinned band lets
// the rows sliding under it show through its own text.
// WHETHER IT DRAWS A CARD IS NOT ITS CALLER'S CALL: on a surface (a dialog, a <Card>, another group's card) it is its
// rows and their hairlines (surfaceGround.ts). A label over things that are not rows is a <Section>.
const { density = `compact`, equalRows } = defineProps<{
    label?: string;
    /** A group that IS a state ("Failed", "Needs you") heads itself in that state's ink. */
    tone?: NonNullable<SectionLabelVariants[`tone`]>;
    undivided?: boolean;
    /** One floor height for simple settings rows on desktop (the tier's `floor`). Keep off groups with drawers or below-row content. */
    equalRows?: boolean;
    /** Leave alone: a group is a list and a list is `compact`. See the note above before overriding. */
    density?: RowDensity;
}>();

provideRowDensity(computed(() => density));

const onGround = useSurfaceGround();
provideRowFlushInline(onGround);
</script>

<template>
    <section>
        <SectionHeader
            v-if="label !== undefined || $slots[`label`] || $slots[`info`] || $slots[`actions`]"
            :label
            :tone
            :class="[ROW_TIERS[density].headingGap, onGround ? `` : ROW_TIERS[density].headingInset]"
        >
            <template v-if="$slots[`label`]" #label><slot name="label" /></template>
            <template v-if="$slots[`info`]" #info><slot name="info" /></template>
            <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
        </SectionHeader>
        <!-- Something about the whole group that is none of its rows (a failing branch's incident card), drawn on its own
             between the label and the rows, so it cannot be read as one more row of the list. -->
        <div v-if="$slots[`lead`]" class="mb-3 flex flex-col gap-3">
            <slot name="lead" />
        </div>
        <!-- Equal rows: a floor every row reaches, centring what it holds by `align-content`, which a <Row> (a wrapping
             flex line) and a plain block child (a note, a skeleton) both answer. -->
        <div
            :class="[
                undivided === true ? `` : `divide-y divide-line-subtle`,
                onGround ? `` : `overflow-hidden rounded-xl bg-card shadow-sm`,
                equalRows ? [ROW_TIERS[density].floor, `*:content-center`] : ``,
            ]"
        >
            <SurfaceGround><slot /></SurfaceGround>
        </div>
    </section>
</template>
