<script setup lang="ts">
import CatalogGrid from "./CatalogGrid.vue";

// A catalog still on its way, in the shape it will arrive in: <CatalogTile>s in <CatalogGrid>, the mark's band, a name
// and a line, so nothing moves when the real tiles land. For the first visit only: after that <Await>'s imprint draws the
// list as it last looked.

const { tiles = 6, control = false } = defineProps<{
    tiles?: number;
    /** The tiles will hold a switch at their end (an installed extension's), so the placeholder holds one too. */
    control?: boolean;
}>();

// Names vary in length, so the bars do too, or the grid reads as a pattern rather than a list.
const NAME_WIDTHS = [`w-24`, `w-32`, `w-20`];
</script>

<template>
    <CatalogGrid aria-hidden="true">
        <!-- Same height as a tile with its two lines, so the grid neither grows nor shrinks when they replace it. -->
        <div v-for="tile in tiles" :key="tile" class="flex h-[2.875rem] items-stretch overflow-hidden rounded-lg bg-card shadow-sm">
            <span class="skeleton block w-11 shrink-0 rounded-none" />
            <div class="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-2.5">
                <span class="skeleton block h-3" :class="NAME_WIDTHS[tile % NAME_WIDTHS.length]" />
                <span class="skeleton block h-2 w-4/5" />
            </div>
            <span v-if="control" class="skeleton mr-3 ml-1 block h-4 w-7 shrink-0 self-center rounded-full" />
        </div>
    </CatalogGrid>
</template>
