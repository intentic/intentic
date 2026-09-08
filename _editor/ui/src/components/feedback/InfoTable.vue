<!--
    Compact reference/comparison table for explainer bodies (<InfoDialog>, <InfoHint>): a lookup list or an A-vs-B comparison. Cells are plain
    strings; the first column is the row subject. `headers` is optional; a leading "" blanks the subject heading.
-->
<script setup lang="ts">
defineProps<{ headers?: string[]; rows: string[][] }>();
</script>

<template>
    <table class="w-full border-collapse text-left align-top text-2xs">
        <thead v-if="headers !== undefined">
            <tr>
                <th
                    v-for="(header, index) in headers"
                    :key="index"
                    class="border-b border-line-subtle pb-1.5 pr-3 align-bottom font-medium uppercase tracking-wide text-subtle last:pr-0"
                >
                    {{ header }}
                </th>
            </tr>
        </thead>
        <tbody>
            <tr v-for="(row, rowIndex) in rows" :key="rowIndex" class="border-b border-line-subtle last:border-b-0">
                <td
                    v-for="(cell, index) in row"
                    :key="index"
                    class="py-1.5 pr-3 align-top last:pr-0"
                    :class="index === 0 ? `font-medium text-content` : `text-muted`"
                >
                    {{ cell }}
                </td>
            </tr>
        </tbody>
    </table>
</template>
