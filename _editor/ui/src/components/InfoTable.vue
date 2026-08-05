<!-- Compact reference/comparison table for explainer bodies (<InfoDialog>, <InfoHint>). Two jobs, one shape:
     a lookup list too long to read as prose (13 cleaners × what each removes) and an A-vs-B comparison
     ("", "Intentic", "Claude"). Both are the case the form heuristic sends to a table rather than a chart — many
     classes that all carry meaning, or two options a reader wants to scan row by row instead of holding two
     paragraphs in their head. Cells are plain strings: the first is the row's subject and wears the primary
     ink, the rest are values in muted ink. Hairline rows, no zebra, no vertical rules — the alignment does
     the separating. `headers` is optional; a leading "" gives the row-subject column a blank heading. -->
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
                    class="border-b border-line pb-1.5 pr-3 align-bottom font-medium uppercase tracking-wide text-subtle last:pr-0"
                >
                    {{ header }}
                </th>
            </tr>
        </thead>
        <tbody>
            <tr v-for="(row, rowIndex) in rows" :key="rowIndex" class="border-b border-line last:border-b-0">
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
