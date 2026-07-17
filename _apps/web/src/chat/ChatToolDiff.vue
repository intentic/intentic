<script setup lang="ts">
import { computed } from "vue";
import { type DiffRow, diffRows } from "./chatToolDiff";

/* Inline unified diff for one structured diff content entry of a tool card. The header path is clickable
 * (opens the file in the workspace); rows come from the lightweight line differ — Monaco stays the
 * full-screen reviewer. */

const props = defineProps<{
    path: string;
    oldText?: string;
    newText: string;
    // The daemon clipped a side at the wire cap — the rendered diff may be incomplete.
    truncated?: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const rows = computed(() => diffRows(props.oldText, props.newText));

const gutterOf = (row: DiffRow): string => (row.type === `add` ? `+` : row.type === `del` ? `-` : ` `);
const rowClass = (row: DiffRow): string => {
    if (row.type === `add`) {
        return `bg-success/10 text-success`;
    }
    if (row.type === `del`) {
        return `bg-danger/10 text-danger`;
    }
    if (row.type === `skip`) {
        return `text-subtle`;
    }
    return `text-muted`;
};
</script>

<template>
    <div class="ml-4 overflow-hidden rounded border border-line bg-canvas">
        <button
            type="button"
            class="flex w-full items-center gap-1.5 border-b border-line px-2 py-1 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
            v-tooltip.top="'Open in workspace'"
            @click="emit('open')"
        >
            <Icon name="file-edit" class="text-2xs text-subtle" />
            <span class="truncate font-mono">{{ path }}</span>
            <span v-if="truncated" class="ml-auto shrink-0 text-subtle">truncated</span>
        </button>
        <pre
            class="scrollbar-thin max-h-56 overflow-auto py-0.5 text-2xs leading-relaxed"
        ><code v-for="(row, index) in rows" :key="index" class="block whitespace-pre-wrap px-2" :class="rowClass(row)">{{ gutterOf(row) }} {{ row.text }}</code></pre>
    </div>
</template>
