<!-- A folder's first look before its listing has been seen here, in the bands' own grids (HomeProbe.vue). -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";

const t = useT();

// The usual folder: its folders as chips under their heading, then its documents as cards. Pictures are a gallery's,
// rarer than either. Name widths for a few chips and two cards.
const CHIP_WIDTHS = [`w-16`, `w-10`, `w-12`, `w-20`, `w-14`];
const CARD_WIDTHS = [`w-20`, `w-16`];
const PAGE_LINES = [`w-full`, `w-5/6`, `w-11/12`, `w-2/3`, `w-full`, `w-3/4`];
</script>

<template>
    <div role="status" aria-busy="true" :aria-label="t(`ui.status.loading`)">
        <h3 aria-hidden="true" class="flex px-2 pt-3 pb-1 text-2xs"><span class="flex h-[1lh] items-center"><span class="skeleton block h-2 w-12" /></span></h3>
        <div aria-hidden="true" class="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5 pb-1.5">
            <div v-for="width in CHIP_WIDTHS" :key="width" class="flex h-9 min-w-0 items-center gap-2 rounded-lg bg-content/[0.045] px-2.5">
                <span class="skeleton block size-3.5 shrink-0" />
                <span class="skeleton block h-2.5" :class="width" />
            </div>
        </div>
        <h3 aria-hidden="true" class="flex px-2 pt-3 pb-1 text-2xs"><span class="flex h-[1lh] items-center"><span class="skeleton block h-2 w-16" /></span></h3>
        <div aria-hidden="true" class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
            <div v-for="width in CARD_WIDTHS" :key="width" class="flex min-w-0 flex-col p-1">
                <!-- The page's miniature of the file's start (HomeCard's preview at its 0.6 scale): a heading, then lines. -->
                <span class="flex h-32 flex-col gap-2 overflow-hidden rounded-md bg-card p-3 ring-1 ring-line/60 ring-inset">
                    <span class="skeleton block h-2.5 w-1/2" />
                    <span v-for="line in PAGE_LINES" :key="line" class="skeleton block h-1.5" :class="line" />
                </span>
                <span class="mt-2 flex h-5 min-w-0 items-center gap-1.5 px-1">
                    <span class="skeleton block size-3 shrink-0" />
                    <span class="skeleton block h-2.5" :class="width" />
                </span>
            </div>
        </div>
    </div>
</template>
