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
    <!-- THE NAME OF A VIEW WITH NO INDEX, IN THE TOP BAR, OVER THE PAGE IT NAMES (2026-11-23): Run, Pipelines, an
         extension's board. A view with an index docked beside it says its name over the index instead (SplitView.vue).
         Blended (`.view-header-blend`, the kit's utilities.css): no ground and no line, so only the bar's height ties it
         to the segments beside it (the board's filter, the chat's title), and its name and controls share their centre
         line. It used to be a text-2xl title a page's padding below the top.
         CENTRED, IN THE CHAT TITLE'S TYPE: the name on the middle of the body's column, at the size and quiet ink the
         chat's title rests in (13px, regular, muted), so the window's names read as one voice and none out-shouts the
         page under it. Three columns, the outer two of equal share, as the chat's bar and the board's search: what the
         view says about itself (`#info`, a count, a tally) and the way back on the left, its controls on the right, so
         neither pushes the name off centre. The row lines up with the body's column, so those stand over its edges.
         Controls are h-7 or lower, like every segment's, and always keep one line: where they need more than their
         equal share the right side takes it (`max-content`), and the name gives up a little of its centre rather than
         the bar a second line (Automations' List | Calendar and New automation beside an index). Only a bar too narrow
         for the three columns at all (under 36rem) drops to one wrapping row, name first (`.view-header-wrap`). -->
    <header class="@container view-header view-header-blend view-header-wrap flex min-w-0 py-1">
        <div
            class="mx-auto flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @xl:grid @xl:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]"
            :class="align"
        >
            <!-- Narrow, the name leads the wrapping row: an empty side would only push it in by a gap. -->
            <div class="min-w-0 items-center gap-2 @xl:flex" :class="back || $slots[`info`] ? `flex` : `hidden`">
                <!-- A button rather than a link: where it goes is history, not an address (see pageBack.ts). -->
                <button
                    v-if="back"
                    type="button"
                    :class="ui.iconButton({ size: `md` }, `-ml-1.5 shrink-0`)"
                    :aria-label="back.label"
                    @click="back.go()"
                >
                    <Icon name="arrow-left" />
                </button>
                <slot name="info" />
            </div>
            <h1 v-if="title !== ``" class="min-w-0 truncate text-center text-[0.8125rem] font-normal text-muted">{{ title }}</h1>
            <span v-else class="skeleton block h-3.5 w-24" aria-hidden="true" />
            <div
                class="ml-auto min-w-0 flex-wrap items-center justify-end gap-2 @xl:ml-0 @xl:flex @xl:flex-nowrap"
                :class="$slots[`actions`] ? `flex` : `hidden`"
            >
                <slot name="actions" />
            </div>
        </div>
    </header>
</template>
