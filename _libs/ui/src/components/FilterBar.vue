<!-- THE INSTRUMENT ABOVE A LIST: free text on the left, the controls that narrow the same list on the right,
     and any bare action furthest right. Six views had written this row by hand and no two agreed — three
     different field treatments (a shrunken `cmp.input`, a framed <SearchBar>, and a bare `relative` +
     absolutely-positioned icon at three different paddings), two different heights, and two different ideas
     about whether the field grows.

     THE FIELD TAKES THE ROW'S SLACK. That is the one layout decision here worth stating: the bar then spans the
     same width as the list under it — one left edge and one right edge down the whole view — instead of a
     control cluster huddled in a corner above a full-width list. `#controls` sits in its own matched track so
     the two read as one instrument; `#actions` stays chromeless beside them because reloading or clearing is
     not a narrowing of anything.

     The field is <SearchBar> rather than a fresh input, so the one line of hard-won CSS in it — `text-base`
     below `md`, the threshold under which iOS Safari zooms the whole page on focus — keeps having exactly one
     home. The border SearchBar deliberately lacks (it is normally a panel's first row) is this wrapper's. -->
<script setup lang="ts">
import SearchBar from "./SearchBar.vue";

const { placeholder = `Filter…` } = defineProps<{
    placeholder?: string;
    /** Shown at the field's trailing edge while a query is active — "how much did I just narrow this to". */
    count?: number;
}>();

const query = defineModel<string>({ required: true });
</script>

<template>
    <div class="flex flex-wrap items-center gap-2">
        <div class="flex h-8 min-w-40 flex-1 items-center overflow-hidden rounded-md border border-line bg-canvas">
            <SearchBar v-model="query" :placeholder="placeholder" class="min-w-0 flex-1 border-b-0" />
            <span v-if="count !== undefined && query.trim() !== ``" class="shrink-0 pr-2.5 text-2xs tabular-nums text-subtle">{{ count }}</span>
        </div>
        <div v-if="$slots[`controls`]" class="flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-1">
            <slot name="controls" />
        </div>
        <slot name="actions" />
    </div>
</template>
