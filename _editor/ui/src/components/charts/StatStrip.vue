<!--
    The orientation strip atop a document: a handful of unrelated counts, deliberately not a chart, since unrelated measures share no axis. Values
    use proportional, not tabular, figures.
-->
<script setup lang="ts">
import type { StatsFigureItem } from "../../markdown/figures.js";

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
