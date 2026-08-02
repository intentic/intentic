<!-- THE INDEX COLUMN — a filter, some pinned rows, grouped selectable rows, a footnote. The activity source
     rail, the memory index and the documentation contents were three implementations of this, and they
     disagreed on every part a reader can see: three selection tints (two `bg-overlay`, one primary-at-13%
     against the app's canonical 15%), two scrollbars, two group-heading treatments, and three filter fields.

     WHAT THIS OWNS IS THE CHROME, NOT THE ROW. A rail's rows differ for good reasons — one carries a gateway
     dot and two counts, one a draft mark and a timestamp, one a path split at its last slash — so the row is a
     scoped slot and stays the caller's. What was never worth three answers is everything around it: where the
     filter sits, how a heading looks, what "selected" is tinted with, and which scrollbar a 16rem column gets.

     HEADINGS CAN STICK. With 55 rows the grouping is otherwise visible only at the moment you scroll past it,
     so `stickyHeadings` keeps the answer to "what am I looking at" on screen. Off by default: it costs a
     stacking context and a background, and a rail with six rows in two groups has nothing to keep.

     FRAMED OR NOT is the real choice between these three, and it is about what the rail sits NEXT to. Against a
     document (documentation, activity) it draws no border — an index that outlines itself competes with the
     thing it exists to reach. Against another panel (memory's reader) it is a panel too, and matching that
     border is what makes the two read as one split view rather than a list beside a card. -->
<script setup lang="ts" generic="T">
import { computed } from "vue";
import { cmp } from "../cmp.js";
import type { NavGroup } from "./navRail.js";
import SearchBar from "./SearchBar.vue";
import { seriesColor } from "./seriesAccent.js";

const {
    filterable = false,
    framed = false,
    stickyHeadings = false,
    placeholder = `Filter…`,
} = defineProps<{
    groups: readonly NavGroup<T>[];
    filterable?: boolean;
    framed?: boolean;
    stickyHeadings?: boolean;
    placeholder?: string;
    /** Shown beside the filter while a query is active. */
    count?: number;
}>();

/* UNNAMED, and it has to stay that way: a NAMED defineModel silently breaks generic threading in this
 * vue-tsc — `T` and every destructured prop stop resolving, in the script as well as the template. The rail
 * has one model anyway (the selection is the row slot's business, not this component's). */
const query = defineModel<string>({ default: `` });

/* A stuck heading needs an opaque background, and which one depends on the surface it is stuck to. Computed
 * here rather than inline: nesting a template literal inside a template literal inside an attribute is a
 * parse the SFC compiler gets wrong silently, taking every other binding in the file with it. */
const headingClass = computed(() => (stickyHeadings ? `sticky top-0 z-10 ${framed ? `bg-card` : `bg-canvas`}` : ``));
</script>

<template>
    <!-- `flex-1` so the column fills the height its container gives it: in a <SplitView> whose panes scroll
         that is the full pane, and a framed rail that stopped after its last row read as a half-drawn box. Where
         the container is content-height instead (a hub's sticky rail) it changes nothing. -->
    <nav class="flex min-h-0 flex-1 flex-col" :class="framed ? `overflow-hidden rounded-lg border border-line bg-card` : ``">
        <!-- Pinned: neither the filter nor a way back to the top is something a reader should have to scroll to
             find, and a pinned row is by definition not a member of any group a filter can empty. -->
        <div v-if="filterable || $slots[`pinned`]" class="flex shrink-0 flex-col gap-1.5" :class="framed ? `` : `pb-2`">
            <div v-if="filterable" class="flex shrink-0 items-center" :class="framed ? `border-b border-line` : `rounded-md bg-content/[0.045]`">
                <SearchBar v-model="query" :placeholder="placeholder" class="min-w-0 flex-1 border-b-0" />
                <span v-if="count !== undefined && query.trim() !== ``" class="shrink-0 pr-2.5 text-2xs tabular-nums text-subtle">{{ count }}</span>
            </div>
            <div v-if="$slots[`pinned`]" :class="framed ? `px-1.5 pt-1.5` : ``"><slot name="pinned" /></div>
        </div>

        <!-- Its own scroller: a 55-entry index and the document beside it have no reason to share one scrollbar,
             and sharing it means you cannot keep your place in either. The right gutter keeps the thumb off the
             rightmost few pixels of every row — which is exactly where the trailing marks sit. -->
        <div class="ui-softscroll min-h-0 flex-1 overflow-y-auto" :class="framed ? `p-1.5` : `pr-2`">
            <!-- THE GAP BETWEEN GROUPS RIDES THE SECTION, not the heading. It was `pt-3 first:pt-0` on the <h3>
                 below, which reads as "space every heading off the group above it, except the first" — and did
                 the opposite: an <h3> is by definition the FIRST CHILD of its own <section>, so `first:` matched
                 on every group and the `pt-3` never applied anywhere. Every heading sat 6px under the last row
                 of the previous group and 10px above its own, which is proximity backwards: the label was
                 nearer to the group it does not describe. Four groups then read as one long list with words in
                 it. On the <section>, `first:` means what it says — only the rail's opening group is flush. -->
            <section v-for="group in groups" :key="group.key" class="pt-3 first:pt-0">
                <h3 v-if="group.label !== undefined" class="flex items-center gap-2 pb-1 pl-2 pr-1" :class="headingClass">
                    <span
                        v-if="group.accent !== undefined"
                        class="size-1.5 shrink-0 rounded-full"
                        :style="{ background: seriesColor(group.accent) }"
                        aria-hidden="true"
                    ></span>
                    <span :class="cmp.sectionLabel(`min-w-0 truncate text-2xs`)">{{ group.label }}</span>
                    <span v-if="group.count !== undefined" class="ml-auto shrink-0 text-2xs tabular-nums text-subtle">{{ group.count }}</span>
                </h3>
                <slot v-for="(item, index) in group.items" name="row" :item="item" :index="index" :group="group" />
            </section>

            <slot v-if="groups.length === 0" name="empty" />
        </div>

        <!-- A footnote about the whole set, below the scroll rather than at the end of it: a number that only
             appears once you have scrolled past every row is a number nobody sees. -->
        <div v-if="$slots[`footer`]" class="shrink-0" :class="framed ? `border-t border-line px-3 py-2` : `pl-2 pt-3`">
            <slot name="footer" />
        </div>
    </nav>
</template>
