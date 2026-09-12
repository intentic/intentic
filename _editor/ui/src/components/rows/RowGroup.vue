<!--
    Grouped-list section: an optional uppercase label (with a count/`#actions`) above one bordered surface of hairline-divided rows. Pairs with
    <Row>; stack multiple groups in a `flex flex-col gap-6` wrapper.
-->
<script setup lang="ts">
import { computed } from "vue";
import { ui } from "../../lib/ui.js";
import { provideRowDensity, type RowDensity } from "./row.js";

// Names the group's subject when the label alone is ambiguous; sits inline with the label since a
// reader who misidentifies the subject has already misread every number below it.
// Drops the surface, for a group already sitting on one (e.g. inside a <Card>); a border between two
// identical `bg-card` surfaces reads as decoration, not structure.
// Replaces the text label for a group drawn as a loading skeleton, whose heading is a bar like the rows under it.
// Drops the hairlines between rows, for a list whose rows are each their own entry (mark, name, spacing)
// rather than one continuous list.
// A group is a list, and a list is `compact`; that is the default and the whole standard. `comfortable`
// remains <Row>'s own fallback outside a group (a card masthead outranking the rows under it). Override
// only as an argued exception; `_tools/checks/row-tiers.mjs` refuses a group that merely restates the default.
// Pins the header to the top of the scroll while rows pass under it, for a header that carries a control
// over the rows (a select-all, bulk verbs) rather than only a label. Padding only when sticky, not a fill:
// bg-canvas on this band reads as a dark box against the card below on the sanctum skin.
const { density = `compact` } = defineProps<{
    label?: string;
    count?: string | number;
    caption?: string;
    flat?: boolean;
    undivided?: boolean;
    sticky?: boolean;
    /** Leave alone: a group is a list and a list is `compact`. See the note above before overriding. */
    density?: RowDensity;
}>();

provideRowDensity(computed(() => density));
</script>

<template>
    <section>
        <div
            v-if="label !== undefined || $slots[`label`] || $slots[`info`] || $slots[`actions`]"
            class="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1"
            :class="
                sticky === true
                    ? // Gap to the surface is padding, not margin, so the sticky header sits flush above the card.
                      `sticky top-0 z-20 -mx-1 px-2 pb-2.5 pt-2`
                    : `mb-2.5`
            "
        >
            <slot name="label"
                ><span v-if="label !== undefined" :class="ui.sectionLabel()">{{ label }}</span></slot
            >
            <!--
                Butted against the label (like PageHeader's `#info`) so an <InfoHint>/<InfoDialog> reads as belonging
                to the group's name, not to the first row under it.
            -->
            <slot name="info" />
            <span v-if="count !== undefined" class="text-2xs font-medium text-subtle">{{ count }}</span>
            <span v-if="caption !== undefined" class="min-w-0 text-2xs text-subtle">{{ caption }}</span>
            <div v-if="$slots[`actions`]" class="ml-auto flex items-center gap-2"><slot name="actions" /></div>
        </div>
        <div
            :class="[
                undivided === true ? `` : `divide-y divide-line-subtle`,
                flat === true ? `` : `overflow-hidden rounded-xl border border-line-subtle bg-card`,
            ]"
        >
            <slot />
        </div>
    </section>
</template>
