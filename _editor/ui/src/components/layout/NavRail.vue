<!-- The index column: a filter, pinned rows, grouped selectable rows, a footnote. -->
<script setup lang="ts" generic="T">
import type { NavGroup } from "./navRail.js";
import SearchBar from "../forms/SearchBar.vue";
import { ROW_TIERS } from "../rows/row.js";
import SectionHeader from "../rows/SectionHeader.vue";
import { seriesColor } from "../charts/seriesAccent.js";
import { useT } from "../../i18n/index.js";

const t = useT();

const { filterable = false, placeholder } = defineProps<{
    groups: readonly NavGroup<T>[];
    filterable?: boolean;
    placeholder?: string;
}>();

/* The model stays unnamed so generic threading remains intact. */
const query = defineModel<string>({ default: `` });
</script>

<template>
    <!-- `flex-1` so the column fills the height its container gives it: in a <SplitView> whose panes scroll that is the full pane. -->
    <!-- `ui-nav-index`: the rows an index is read at (utilities.css), whoever draws them. -->
    <nav class="ui-nav-index flex min-h-0 flex-1 flex-col">
        <!-- Pinned: neither the filter nor a way back to the top is something a reader should have to scroll to find. -->
        <!-- `pr-2`, the scroll area's own gutter below, so the field ends where the rows do. -->
        <div v-if="filterable || $slots[`pinned`]" class="flex shrink-0 flex-col gap-1.5 pr-2 pb-3">
            <!-- A FILLED field, not an outlined one: a box drawn at the top of a column that has no other boxes in it is the first thing the eye lands on. -->
            <SearchBar
                v-if="filterable"
                v-model="query"
                variant="field"
                clearable
                :placeholder="placeholder ?? t(`ui.action.filter`)"
                class="shrink-0"
            />
            <div v-if="$slots[`pinned`]"><slot name="pinned" /></div>
        </div>

        <!-- The index and document use separate scroll containers. -->
        <div class="ui-softscroll min-h-0 flex-1 overflow-y-auto pr-2">
            <!-- THE GAP BETWEEN GROUPS RIDES THE SECTION, not the heading. -->
            <!-- A hairline between groups, so the index scans as a few blocks rather than one run of rows; the first has none. -->
            <section
                v-for="group in groups"
                :key="group.key"
                class="mt-3 border-t border-line-subtle pt-3 first:mt-0 first:border-t-0 first:pt-0"
            >
                <!-- The rail's own tier's header, and it scrolls with its rows: a pinned one needs a fill to scroll under, and a band behind a header is what the documentation rail was fixed for three times. -->
                <SectionHeader
                    v-if="group.label !== undefined"
                    :label="group.label"
                    :heading="3"
                    density="dense"
                    :class="[ROW_TIERS.dense.headingGap, ROW_TIERS.dense.headingInset]"
                >
                    <template v-if="group.accent !== undefined" #mark>
                        <span class="size-1.5 shrink-0 rounded-full" :style="{ background: seriesColor(group.accent) }" aria-hidden="true"></span>
                    </template>
                </SectionHeader>
                <!-- A HAIRLINE BETWEEN ROWS, because these rows are ROUNDED AND TINTED. -->
                <div class="flex flex-col gap-0.5">
                    <slot v-for="(item, index) in group.items" name="row" :item="item" :index="index" :group="group" />
                </div>
            </section>

            <slot v-if="groups.length === 0" name="empty" />
        </div>

        <!-- A footnote about the whole set, below the scroll rather than at the end of it. -->
        <div v-if="$slots[`footer`]" class="shrink-0 pl-2 pt-3">
            <slot name="footer" />
        </div>
    </nav>
</template>
