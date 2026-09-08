<!--
    N row-shaped loading placeholders for a <RowGroup>, built from real <Row> slots so padding/gap/density inherit and match the eventual list
    exactly. Density comes from the enclosing <RowGroup>. Bars are `aria-hidden`; the caller owns the `role="status"`.
-->
<script setup lang="ts">
import Row from "../rows/Row.vue";
import { type RowDensity, useRowDensity } from "../rows/row.js";

const {
    rows = 3,
    density,
    lead = true,
    description = false,
    control = false,
} = defineProps<{
    /** How many placeholder rows. Match the shortest list worth promising, not the longest one seen. */
    rows?: number;
    /** Leave it unset: the <RowGroup> this is dropped into is the same one the real rows land in. */
    density?: RowDensity;
    /** A leading glyph's square, for lists whose rows carry an icon or an avatar. */
    lead?: boolean;
    /** A second, shorter line under the title, for rows that are both titled and described. */
    description?: boolean;
    /** A trailing control's block: a switch, a badge, a button. */
    control?: boolean;
}>();

// The tier the outline is promising: this call's own answer if it gave one, else the group it is standing in.
const tier = useRowDensity(() => density);

// Walked in order and wrapped, so two rows are never the same length and eight rows do not read as a pattern.
const TITLE_WIDTHS = [`w-40`, `w-28`, `w-48`, `w-32`, `w-36`, `w-24`];
const DESCRIPTION_WIDTHS = [`w-56`, `w-64`, `w-44`, `w-52`];
// Glyph square scales with tier; a square sized for a settings row would widen a dense rail's gutter.
const LEAD = { comfortable: `h-4.5 w-4.5`, compact: `h-3.5 w-3.5`, dense: `h-3 w-3` } as const;
// Bar is thinner than the text it replaces; `min-h-[1lh]` keeps the row's height matching the inherited text.
const BAR = { comfortable: `h-3.5`, compact: `h-3`, dense: `h-2.5` } as const;
</script>

<template>
    <Row v-for="index in rows" :key="index" :density="tier" aria-hidden="true">
        <template v-if="lead" #lead><span class="skeleton block shrink-0" :class="LEAD[tier]" /></template>
        <template #title>
            <span class="flex min-h-[1lh] items-center">
                <span class="skeleton block" :class="[BAR[tier], TITLE_WIDTHS[(index - 1) % TITLE_WIDTHS.length]]" />
            </span>
        </template>
        <template v-if="description" #description>
            <span class="flex min-h-[1lh] items-center">
                <span class="skeleton block h-2.5" :class="DESCRIPTION_WIDTHS[(index - 1) % DESCRIPTION_WIDTHS.length]" />
            </span>
        </template>
        <template v-if="control" #control><span class="skeleton block h-7 w-20" /></template>
    </Row>
</template>
