<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { countSelection, selectionLine } from "./selectionSummary";

// The lines at the tree pane's foot, outside the tree and below its flex-1 body, so they rest at the pane's bottom edge
// rather than right under the last row, where a press meant for a file would land on them.

const t = useT();

const { technical, selection, entries } = defineProps<{
    // How many technical files the switch hid from what is in sight; 0 draws no receipt (none hidden, a filter typed, or
    // a cover chosen, which lists no file at all, so the switch would change nothing in sight).
    technical: number;
    selection: ReadonlySet<string>;
    entries: ReadonlyMap<string, WorkspaceTreeEntry>;
}>();
const emit = defineEmits<{ showTechnical: [] }>();

// What several selected rows amount to (selectionSummary.ts); nothing for a single row.
const selected = computed(() => selectionLine(countSelection(selection, (path) => entries.get(path))));
</script>

<template>
    <!-- The technical switch's own receipt: a press here is the way back, so the hidden files are never a mystery. -->
    <button
        v-if="technical > 0"
        type="button"
        class="flex w-full shrink-0 items-center gap-1.5 px-2 py-1 text-left text-2xs italic text-subtle transition-colors hover:text-content"
        v-tooltip.top="{ title: t(`workspace.workspaceTree.showFiles`), note: t(`workspace.workspaceTree.technicalKinds`) }"
        @click="emit(`showTechnical`)"
    >
        <span class="w-[0.7rem] shrink-0"></span>
        <span class="min-w-0 flex-1 truncate">{{ t(`workspace.workspaceTree.technicalHidden`, { count: technical }, technical) }}</span>
    </button>
    <!-- A file manager's status line: how many rows are selected and what the files weigh. Words only, nothing to press. -->
    <p v-if="selected !== undefined" class="flex shrink-0 items-center gap-1.5 px-2 py-1 text-2xs text-subtle" aria-live="polite">
        <span class="w-[0.7rem] shrink-0"></span>
        <span class="min-w-0 flex-1 truncate">{{ selected }}</span>
    </p>
</template>
