<!-- A section: the one header (<SectionHeader>) over whatever it heads (cards, a grid, a form), drawing no surface. A list is a <RowGroup>: this plus the rows' card. -->
<script setup lang="ts">
import { computed } from "vue";
import type { SectionLabelVariants } from "../../lib/ui.js";
import { provideRowDensity, ROW_TIERS, type RowDensity } from "./row.js";
import SectionHeader from "./SectionHeader.vue";

const { density = `compact` } = defineProps<{
    label?: string;
    tone?: NonNullable<SectionLabelVariants[`tone`]>;
    heading?: 2 | 3 | 4;
    /** Leave unset, as on a <RowGroup>; a dense surface's section (a status bar's panel, a picker's group) is `dense`. */
    density?: RowDensity;
}>();

// What it holds draws at its tier, as on a group: a note or a row inside a section is the section's size.
provideRowDensity(computed(() => density));
</script>

<template>
    <section>
        <SectionHeader
            v-if="label !== undefined || $slots[`label`] || $slots[`info`] || $slots[`actions`]"
            :label
            :tone
            :heading
            :density
            :class="ROW_TIERS[density].headingGap"
        >
            <template v-if="$slots[`label`]" #label><slot name="label" /></template>
            <template v-if="$slots[`info`]" #info><slot name="info" /></template>
            <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
        </SectionHeader>
        <slot />
    </section>
</template>
