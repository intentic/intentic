<!-- The orientation strip at the top of a document: a handful of counts a reader wants before any prose.

     NOT A CHART, deliberately. These are unrelated measures: packages, lines, test coverage, and drawing
     unrelated measures as one chart is the dual-axis mistake. When the form is a number, the form is a number.

     No colour encoding: nothing here is a series, so everything wears text tokens. The values use the font's
     default PROPORTIONAL figures rather than tabular-nums: these are standalone display numbers, not a column
     that has to align, and tabular digits make a value like "121" read loose at this size. -->
<script setup lang="ts">
import type { StatsFigureItem } from "../markdown/figures.js";

const { items } = defineProps<{ items: readonly StatsFigureItem[] }>();
</script>

<template>
    <dl class="my-4 flex flex-wrap gap-x-10 gap-y-4">
        <div v-for="item in items" :key="item.label" class="flex min-w-24 flex-col gap-0.5">
            <dt class="text-2xs text-muted">{{ item.label }}</dt>
            <dd class="text-xl font-semibold leading-none text-content">{{ item.value }}</dd>
            <dd v-if="item.note !== undefined" class="text-2xs text-subtle">{{ item.note }}</dd>
        </div>
    </dl>
</template>
