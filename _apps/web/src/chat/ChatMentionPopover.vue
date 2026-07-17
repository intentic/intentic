<script setup lang="ts">
import { useListNavigation } from "@intentic-app/ui";
import { computed, ref, toRef } from "vue";
import { useWorkspaceSearch } from "../composables/workspace/useWorkspaceSearch";

/* The composer's @-mention picker: an inline panel above the textarea listing workspace files matching the
 * active token (the daemon's ranked filename search — the QuickOpen data path). The parent owns the keyboard
 * flow (the textarea keeps focus) and calls the exposed move/pickActive from its keydown handler. */

const props = defineProps<{ query: string }>();
const emit = defineEmits<{ pick: [path: string] }>();

const active = ref(true);
const mode = ref<`files`>(`files`);
const { groups, searching, pending } = useWorkspaceSearch(toRef(props, `query`), active, mode);

const MAX_ROWS = 8;
const paths = computed<readonly string[]>(() => groups.value.slice(0, MAX_ROWS).map((group) => group.path));

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(paths, (path) => path);

const pickActive = (): boolean => {
    const path = activeRow.value;
    if (path === undefined) {
        return false;
    }
    emit(`pick`, path);
    return true;
};

defineExpose({ move, pickActive });

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const parentDir = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
</script>

<template>
    <div class="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-xl border border-line-strong bg-card shadow-lg">
        <p class="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-2xs uppercase tracking-wide text-subtle">
            <Icon name="paperclip" class="text-2xs" />
            Mention a file
            <Icon v-if="searching || pending" name="spinner" class="text-2xs" spin />
        </p>
        <p v-if="query.length < 2" class="px-3 py-2 text-xs text-subtle">Keep typing to search files…</p>
        <p v-else-if="paths.length === 0 && !searching && !pending" class="px-3 py-2 text-xs text-subtle">No files match "{{ query }}".</p>
        <button
            v-for="(path, index) in paths"
            :key="path"
            :ref="(el) => setRowEl(path, el)"
            type="button"
            class="mp-row flex w-full items-center gap-2 px-3 py-1.5 text-left"
            :class="{ 'bg-overlay': index === activeIndex }"
            @mousedown.prevent="emit('pick', path)"
        >
            <Icon name="file" class="shrink-0 text-2xs text-subtle" />
            <span class="truncate text-sm text-content">{{ basename(path) }}</span>
            <span v-if="parentDir(path)" class="truncate text-2xs text-subtle">{{ parentDir(path) }}</span>
        </button>
    </div>
</template>
