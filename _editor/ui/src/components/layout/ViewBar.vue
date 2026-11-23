<!-- A view's segment of the window's top bar: its name, and the way back, on the left, its own controls on the right. -->
<script setup lang="ts">
import { ui } from "../../lib/ui.js";
import { usePageBack } from "./pageBack.js";

const { title } = defineProps<{
    /** The view's name. Empty while the host still waits to learn it: a bar holds its place, never a guess. */
    title: string;
    /** Classes for the row inside, lining it up with the column of the body below (that column's cap). */
    align?: string;
}>();

const back = usePageBack();
</script>

<template>
    <!-- THE VIEW'S NAME, IN THE TOP BAR, OVER THE PAGE IT NAMES (2026-11-23). Blended (`.view-header-blend`, the kit's
         utilities.css): no ground and no line, so only the bar's height ties it to the segments beside it (the board's
         filter, the chat's title), and its name and controls share their centre line. Its row lines up with the body's
         column, so the name stands over the content's left edge and the controls over its right. It used to be a
         text-2xl title a page's padding below the top, or, beside an index, the index's own heading, so a view's name
         sat in a different place, at a different size, depending on whether it had an index.
         Controls are h-7 or lower, like every segment's. A pane too narrow for name and controls on one line lets the
         controls take a second (`.view-header-wrap`) rather than cut the name down. -->
    <header class="view-header view-header-blend view-header-wrap flex min-w-0 py-1">
        <div class="mx-auto flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1" :class="align">
            <div class="flex min-w-0 flex-auto items-center gap-2">
                <!-- A button rather than a link: where it goes is history, not an address (see pageBack.ts). -->
                <button
                    v-if="back"
                    type="button"
                    :class="ui.iconButton({ size: `md` }, `-ml-1.5 -mr-0.5 shrink-0`)"
                    :aria-label="back.label"
                    @click="back.go()"
                >
                    <Icon name="arrow-left" />
                </button>
                <h1 v-if="title !== ``" class="min-w-0 truncate text-sm font-semibold">{{ title }}</h1>
                <span v-else class="skeleton block h-4 w-32" aria-hidden="true" />
                <slot name="info" />
            </div>
            <div v-if="$slots[`actions`]" class="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                <slot name="actions" />
            </div>
        </div>
    </header>
</template>
