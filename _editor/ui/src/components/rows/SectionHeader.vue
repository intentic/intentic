<!-- The one section header: a label, `#info` beside it, `#actions` at the line's end. <RowGroup>, <Section> and <NavRail> draw it over what it heads, at their tier's distance; alone it is the line itself (a toolbar's label, a status panel's title). -->
<script setup lang="ts">
import { computed } from "vue";
import { type SectionLabelVariants, ui } from "../../lib/ui.js";
import { ROW_TIERS, type RowDensity, useRowDensity } from "./row.js";

// What it cannot say, on purpose. NO COUNT: the rows under it are the tally. NO CAPTION: words beside a label were
// removed view by view until the owner called them useless, so a reader who needs a sentence gets a <RowNote> in the
// list. NO FILL: a band behind a header reads as a dark box on a textured skin, which is why it also cannot pin. NO
// CLASS FOR ITS GEOMETRY: its size is its tier's (row.ts), so a rail's header is a step under a page's, and the room
// under it is the <Section>'s, <RowGroup>'s or <NavRail>'s that draws it, at that tier's distance.
const {
    tone = `neutral`,
    heading,
    density,
} = defineProps<{
    label?: string;
    /** A group that IS a state ("Failed", "Needs you") heads itself in that state's ink. */
    tone?: NonNullable<SectionLabelVariants[`tone`]>;
    /** Renders the label as a real heading, for a page whose outline a screen reader walks. Changes no pixel. */
    heading?: 2 | 3 | 4;
    // Leave unset: a header takes its list's tier (<RowGroup> publishes it; <NavRail> passes `dense`), and on its own
    // is a page's.
    density?: RowDensity;
}>();

const inForce = useRowDensity(() => density);
const tier = computed(() => ROW_TIERS[inForce.value]);
</script>

<template>
    <div class="flex flex-wrap items-center" :class="tier.headingLine">
        <!-- A leading mark (a component's colour dot in a rail). -->
        <slot name="mark" />
        <component :is="heading === undefined ? `span` : `h${heading}`" :class="ui.sectionLabel({ size: tier.heading, tone }, tier.headingLabel)">
            <slot name="label">{{ label }}</slot>
        </component>
        <!-- Info controls stay attached to the label. -->
        <slot name="info" />
        <div v-if="$slots[`actions`]" class="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            <slot name="actions" />
        </div>
    </div>
</template>
