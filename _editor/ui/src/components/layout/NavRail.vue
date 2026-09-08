<!--
    The index column: a filter, pinned rows, grouped selectable rows, a footnote. Owns the chrome only; row content is a caller-supplied slot. Never
    draws a border. `stickyHeadings` pins the group heading while scrolling.
-->
<script setup lang="ts" generic="T">
import { computed } from "vue";
import { ui } from "../../lib/ui.js";
import type { NavGroup } from "./navRail.js";
import SearchBar from "../forms/SearchBar.vue";
import { seriesColor } from "../charts/seriesAccent.js";

const {
    filterable = false,
    stickyHeadings = false,
    placeholder = `Filter…`,
} = defineProps<{
    groups: readonly NavGroup<T>[];
    filterable?: boolean;
    stickyHeadings?: boolean;
    placeholder?: string;
    /** Shown beside the filter while a query is active. */
    count?: number;
}>();

/* UNNAMED, and it has to stay that way: a NAMED defineModel silently breaks generic threading in this
 * vue-tsc: `T` and every destructured prop stop resolving, in the script as well as the template. The rail
 * has one model anyway (the selection is the row slot's business, not this component's). */
const query = defineModel<string>({ default: `` });

// A stuck heading needs an opaque background to scroll rows under, and the rail always sits on the page.
const headingClass = computed(() => (stickyHeadings ? `sticky top-0 z-10 bg-canvas` : ``));
</script>

<template>
    <!-- `flex-1` so the column fills the height its container gives it: in a <SplitView> whose panes scroll that
         is the full pane. Where the container is content-height instead (a hub's sticky rail) it changes nothing. -->
    <nav class="flex min-h-0 flex-1 flex-col">
        <!-- Pinned: neither the filter nor a way back to the top is something a reader should have to scroll to
             find, and a pinned row is by definition not a member of any group a filter can empty. -->
        <div v-if="filterable || $slots[`pinned`]" class="flex shrink-0 flex-col gap-1.5 pb-2">
            <!-- A FILLED field, not an outlined one: a box drawn at the top of a column that has no other boxes
                 in it is the first thing the eye lands on, and it is a text input. -->
            <div v-if="filterable" class="flex shrink-0 items-center rounded-md bg-content/[0.045]">
                <SearchBar v-model="query" :placeholder="placeholder" class="min-w-0 flex-1 border-b-0" />
                <span v-if="count !== undefined && query.trim() !== ``" class="shrink-0 pr-2.5 text-2xs tabular-nums text-subtle">{{ count }}</span>
            </div>
            <div v-if="$slots[`pinned`]"><slot name="pinned" /></div>
        </div>

        <!-- Its own scroller: a 55-entry index and the document beside it have no reason to share one scrollbar,
             and sharing it means you cannot keep your place in either. The right gutter keeps the thumb off the
             rightmost few pixels of every row, which is exactly where the trailing marks sit. -->
        <div class="ui-softscroll min-h-0 flex-1 overflow-y-auto pr-2">
            <!-- THE GAP BETWEEN GROUPS RIDES THE SECTION, not the heading. It was `pt-3 first:pt-0` on the <h3>
                 below, which reads as "space every heading off the group above it, except the first", and did
                 the opposite: an <h3> is by definition the FIRST CHILD of its own <section>, so `first:` matched
                 on every group and the `pt-3` never applied anywhere. Every heading sat 6px under the last row
                 of the previous group and 10px above its own, which is proximity backwards: the label was
                 nearer to the group it does not describe. Four groups then read as one long list with words in
                 it. On the <section>, `first:` means what it says, only the rail's opening group is flush. -->
            <section v-for="group in groups" :key="group.key" class="pt-3 first:pt-0">
                <h3 v-if="group.label !== undefined" class="flex items-center gap-2 pb-1 pl-2 pr-1" :class="headingClass">
                    <span
                        v-if="group.accent !== undefined"
                        class="size-1.5 shrink-0 rounded-full"
                        :style="{ background: seriesColor(group.accent) }"
                        aria-hidden="true"
                    ></span>
                    <span :class="ui.sectionLabel(`min-w-0 truncate text-2xs`)">{{ group.label }}</span>
                    <span v-if="group.count !== undefined" class="ml-auto shrink-0 text-2xs tabular-nums text-subtle">{{ group.count }}</span>
                </h3>
                <!-- A HAIRLINE BETWEEN ROWS, because these rows are ROUNDED AND TINTED. Butted together, the
                     selected row and the one under the pointer paint two tints that touch along a straight
                     edge, and the pair reads as one taller block with a colour change in it rather than as two
                     rows: the rounding says "separate object" and the shared edge says the opposite. 2px is
                     enough to part them and is not enough to loosen a fifty-row column into a list of cards. -->
                <div class="flex flex-col gap-0.5">
                    <slot v-for="(item, index) in group.items" name="row" :item="item" :index="index" :group="group" />
                </div>
            </section>

            <slot v-if="groups.length === 0" name="empty" />
        </div>

        <!-- A footnote about the whole set, below the scroll rather than at the end of it: a number that only
             appears once you have scrolled past every row is a number nobody sees. -->
        <div v-if="$slots[`footer`]" class="shrink-0 pl-2 pt-3">
            <slot name="footer" />
        </div>
    </nav>
</template>
