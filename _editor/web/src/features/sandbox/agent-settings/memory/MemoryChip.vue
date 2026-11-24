<script setup lang="ts">
import { MEMORY_MAX_CHARS } from "@intentic/constants";
import { formatCompact, type Tip, timeAgo, ui } from "@intentic/ui";
import { computed } from "vue";
import MemoryGauge from "./MemoryGauge.vue";
import type { MemoryFile } from "./memoryFiles";
import { useT } from "@intentic/ui/i18n";

// One memory file as a pill: the folder whose turns read it (the file's own name for the workspace's), and a gauge of how
// much of a turn's room for memory it takes. What it says is its page's to show, opened by a press; the hover holds the
// numbers the gauge stands for.

const t = useT();

const { file } = defineProps<{ file: MemoryFile }>();
const emit = defineEmits<{ open: [] }>();

const label = computed(() => (file.folder === `` ? file.path : file.folder));

const tip = computed(
    (): Tip => ({
        title: file.path,
        tone: file.dropped ? `danger` : undefined,
        rows: [
            { label: t(`sandbox.agentMemory.size`), value: `${formatCompact(file.size)} / ${formatCompact(MEMORY_MAX_CHARS)}` },
            ...(file.mtime === undefined ? [] : [{ label: t(`sandbox.agentMemory.edited`), value: timeAgo(file.mtime, { days: true }) }]),
        ],
        note: file.dropped ? t(`sandbox.agentMemory.leftOut`) : undefined,
    }),
);
</script>

<template>
    <button type="button" data-memory-chip :class="ui.chip({ lead: true })" class="max-w-full font-mono" v-tooltip.top="tip" @click="emit(`open`)">
        <MemoryGauge :share="file.share" :dropped="file.dropped" />
        <span class="truncate">{{ label }}</span>
        <span v-if="file.dropped" class="sr-only">{{ t(`sandbox.agentMemory.leftOut`) }}</span>
    </button>
</template>
