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
/* A GROUP IS A LIST, AND A LIST IS `compact`. THAT IS THE DEFAULT, AND IT IS THE WHOLE STANDARD.
 *
 * The tier used to be a judgement made per group — "is this a settings row or a record row?" — and the app
 * answered it 85 times and got two answers. Measured across every group in the build: 51 were `compact`, 33 were
 * `comfortable`, and ALL THIRTY-THREE of those had simply never stated a tier. Not one group in the app ever
 * chose `comfortable` on purpose. It was not a decision, it was a default nobody was asked about, and it landed
 * wherever nobody had thought about it.
 *
 * WHAT THAT COST IS A HUB THAT CHANGES LANGUAGE AS YOU TAB THROUGH IT. In the Sandbox hub, Personas, Extensions,
 * Environment and Access drew their row titles at 14px/500; Agent, Status and Devices drew theirs at 16px/600,
 * with a 18px glyph beside a 14px one. In Settings, Keybindings was 14px/500 and Appearance, Notifications and
 * Data were 16px/600 — one nav rail, two row languages, and which one you got depended on which file somebody
 * had edited last. Inside a SINGLE tab it contradicted itself: Agent ▸ Skills and Agent ▸ Rules were compact
 * while Agent ▸ Models and Agent ▸ Instructions were not.
 *
 * THE QUESTION WAS NOT DECIDABLE, WHICH IS WHY IT KEPT BEING DECIDED DIFFERENTLY. "Models" is three rows with a
 * picker on each: a settings list, or a record list of model tiers? "Your listings" is five services with a
 * badge and four verbs. "Devices" is machines with switches on them. Every one of those reads both ways, so
 * the taxonomy was never doing the work — a reader tabbing between them is not classifying anything, they are
 * looking at rows, and rows on one surface have one size.
 *
 * SO THE TAXONOMY IS GONE AND THE STRUCTURE ANSWERS INSTEAD: if it is in a <RowGroup>, it is a list, and it is
 * compact. There is nothing left to get wrong, and nothing to remember at a call site.
 *
 * `comfortable` DID NOT DIE — IT MOVED TO WHAT IT WAS ACTUALLY FOR. A card's masthead (`<Row flush :heading="2">`)
 * is not in a group, so it keeps <Row>'s own `comfortable` fallback: its 18px glyph belongs beside an h2, and it
 * has to outrank the rows underneath it. That is a RANK, which is a real distinction; "this list feels more like
 * settings than records" was not.
 *
 * Passing it here is still possible and still legitimate for the group that genuinely disagrees — but it is now
 * an argued exception rather than the thing you get by not looking, and `_tools/checks/row-tiers.mjs` refuses a
 * group that merely restates the default. */
const { density = `compact` } = defineProps<{
    label?: string;
    count?: string | number;
    caption?: string;
    flat?: boolean;
    undivided?: boolean;
    /** Leave it alone: a group is a list and a list is `compact`. See the note above before overriding. */
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
