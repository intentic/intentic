<script setup lang="ts">
import { computed } from "vue";
import Icon from "../primitives/Icon.vue";

// The open project as a chip, and the way out of it: one control for every surface the project scope narrows (the
// file tree, the agents board, an extension's rows), so the shell says "web · 3 hidden" the same way everywhere.
// Draws nothing while no project is open, which needs no marker. `hidden` is what THIS surface put out of sight,
// counted in its own rows; `noun` names them for the tooltip. Clearing is the caller's, since the scope is the shell's.

const { project, hidden = 0, noun = `rows`, compact = false } = defineProps<{ project?: string | undefined; hidden?: number; noun?: string; compact?: boolean }>();
const emit = defineEmits<{ clear: [] }>();

const hint = computed(() =>
    project === undefined
        ? ``
        : `Showing ${noun} on ${project} only${hidden > 0 ? `, ${hidden} elsewhere` : ``}. Click to show every project's.`,
);
</script>

<template>
    <button
        v-if="project !== undefined"
        type="button"
        class="ui-chip ui-chip-on h-6 shrink-0 px-1.5"
        :aria-label="hint"
        v-tooltip.bottom="hint"
        @click="emit(`clear`)"
    >
        <Icon name="folder-open" class="shrink-0 text-[0.7rem]" />
        <!-- `compact` drops the name on a narrow bar; the tooltip and the rail tile still say which project. -->
        <span class="max-w-32 truncate" :class="{ 'max-lg:hidden': compact }">{{ project }}</span>
        <span v-if="hidden > 0" class="text-subtle" :class="{ 'max-lg:hidden': compact }">· {{ hidden }} hidden</span>
        <Icon name="times" class="shrink-0 text-[0.6rem] opacity-70" />
    </button>
</template>
