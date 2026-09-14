<!-- Grouped-list section: an optional uppercase label (with a count/`#actions`) above one bordered surface of hairline-divided rows. -->
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
// The header scrolls with its rows: a group header cannot pin, because this band carries no fill (bg-canvas
// here reads as a dark box against the card below on the sanctum skin) and a transparent pinned band lets
// the rows sliding under it show through its own text.
const { density = `compact` } = defineProps<{
    label?: string;
    count?: string | number;
    caption?: string;
    flat?: boolean;
    undivided?: boolean;
    /** Leave alone: a group is a list and a list is `compact`. See the note above before overriding. */
    density?: RowDensity;
}>();

provideRowDensity(computed(() => density));
</script>

<template>
    <section>
        <div
            v-if="label !== undefined || $slots[`label`] || $slots[`info`] || $slots[`actions`]"
            class="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1"
        >
            <slot name="label"
                ><span v-if="label !== undefined" :class="ui.sectionLabel()">{{ label }}</span></slot
            >
<!-- Info controls stay attached to the group label. -->
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
