<!-- Grouped-list section: an optional uppercase label (with an optional count / #actions cluster) floating
     above ONE bordered surface whose direct children are hairline-divided rows. The app-wide replacement for
     stacking a separate <Card> per option: related settings share a surface, so the border means "these
     belong together" again instead of boxing every line. Pair with <Row>; stack multiple RowGroups in a
     `flex flex-col gap-6` page wrapper. Mirrors the grouped-list already used on the Secrets page. -->
<script setup lang="ts">
import { computed } from "vue";
import { ui } from "../lib/ui.js";
import { provideRowDensity, type RowDensity } from "./row.js";

// `caption` names the group's SUBJECT when the label alone leaves it ambiguous ("Plan limits: your whole
// Claude plan, not this sandbox"). It sits inline with the label rather than under the surface because a reader
// who misidentifies the subject has already misread every number below by the time a footnote reaches them.
//
/* `flat` DROPS THE SURFACE, for the groups that are already on one. A border earns its keep by separating this
 * content from the canvas: put the same group inside a <Card> and it separates a surface from an identical
 * surface, because `bg-card` is what both are painted in: the stroke is then the only thing distinguishing
 * them, so it reads as decoration rather than as structure. Three of them stacked in one card (the sandbox's
 * environment contents) is a frame, three inner frames and a hairline per row: four levels of stroke saying
 * one thing. Flat keeps the label, the count and the row dividers and lets the CARD be the only frame; the
 * uppercase label plus the gap between sections is what groups them, which is all a reader was using anyway. */
/* `#label` REPLACES the text label for the one case that has no text yet: a group being drawn as a loading
 * outline, whose heading is a bar like the rows under it. It exists so a skeleton can use this component rather
 * than re-typing its label box and row dividers, which is how an outline drifts from the group it stands in
 * for, the failure every other note in this file is about. */
/* `undivided` DROPS THE HAIRLINES BETWEEN ROWS. A divider separates rows that are read as one continuous list;
 * where each row is its own openable entry with a mark, a name and its own spacing (the sandbox's environment
 * contents), the lines are one more stroke on a surface that already has a frame, and the rhythm of the rows is
 * what separates them. */
/* `density` IS THE GROUP'S, AND EVERY ROW ON ITS SURFACE READS IT. A record list says `compact` once here
 * instead of on each of its rows, its loading outline and each note between them — which is what those three
 * had to do before, and what one of them always eventually forgot. See the long note in row.ts for the four
 * lists this had already come apart on. `comfortable` is the default because a group of settings rows is what
 * this component was built for, and that is what every existing call site draws. */
const { density = `comfortable` } = defineProps<{
    label?: string;
    count?: string | number;
    caption?: string;
    flat?: boolean;
    undivided?: boolean;
    /** comfortable: settings rows · compact: record lists · dense: navigator rails. */
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
            <!-- Butted against the label (like PageHeader's own #info) so an <InfoHint>/<InfoDialog> reads as
                 belonging to the group's NAME, not to the first row under it. -->
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
