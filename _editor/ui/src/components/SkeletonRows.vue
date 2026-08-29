<!-- The outline of a list that has not arrived yet: N row-shaped placeholders, for dropping straight into a
     <RowGroup> where the real <Row>s are about to go.

     IT RENDERS REAL ROWS. The bars go into <Row>'s own slots rather than into a hand-built div, so the outline
     inherits that component's padding, gap and density tiers by construction: an outline that merely LOOKS like
     the list is one that drifts from it the first time a tier changes, and the list then jumps as it lands. This
     is the difference between a placeholder and a promise the content keeps.

     DENSITY COMES FROM THE <RowGroup> IT IS DROPPED INTO, which is the whole of what "inherits by construction"
     was supposed to mean and, until the tier became the group's, was not what happened. The outline re-declared
     its tier at its own call site, so on the personas list, the payouts page and the services page it promised
     comfortable rows and then landed compact ones — the list visibly shrank as it arrived, under a comment on
     the payouts page saying that could not happen. Lead and control are still the caller's: they say what SHAPE
     is coming, which is a fact about this list's rows and not about their size.

     Widths are a fixed uneven set walked in order: real names are uneven, and an outline that reshuffles on
     every re-render is an animation nobody asked for.

     The bars are decoration: `aria-hidden` here, with the caller owning the one `role="status"` for the region,
     since a list is rarely the only thing on a loading page and five status regions announce a wait five times. -->
<script setup lang="ts">
import Row from "./Row.vue";
import { type RowDensity, useRowDensity } from "./row.js";

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
    /** A second, shorter line under the title, for lists whose rows are titled AND described. */
    description?: boolean;
    /** A trailing control's block: a switch, a badge, a button. */
    control?: boolean;
}>();

// The tier the outline is promising: this call's own answer if it gave one, else the group it is standing in.
const tier = useRowDensity(() => density);

// Walked in order and wrapped, so two rows are never the same length and eight rows do not read as a pattern.
const TITLE_WIDTHS = [`w-40`, `w-28`, `w-48`, `w-32`, `w-36`, `w-24`];
const DESCRIPTION_WIDTHS = [`w-56`, `w-64`, `w-44`, `w-52`];
// The glyph square scales with the tier: a dense rail's icon is `text-xs`, and a square sized for a settings
// row would make the outline wider in the gutter than the list it stands in for.
const LEAD = { comfortable: `h-4.5 w-4.5`, compact: `h-3.5 w-3.5`, dense: `h-3 w-3` } as const;
// A BAR IS THINNER THAN THE TEXT IT REPLACES, which is what `min-h-[1lh]` below is for and why the bar's own
// height can stay a matter of looks. Left to itself a 14px bar standing in for a 22px line makes every row
// shorter than the row that lands, and the list then jumps as it fills: measured at 58px against 67px before
// this. `1lh` is one line box of whatever text the slot inherits (Row puts the tier's font and leading on the
// wrapper around it), so the row keeps the height of the row it is promising, in every tier, for free.
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
