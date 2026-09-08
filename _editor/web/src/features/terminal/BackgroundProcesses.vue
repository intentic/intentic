<script setup lang="ts">
import { AnchoredOverlay, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "./useBackgroundProcesses";

// Background-processes control for managed processes, extension gateways, dockerd: status, read-only logs,
// explicit start/stop, not killable terminal tabs. Hidden until there is anything to show.

const { rows, busy, start, stop } = useBackgroundProcesses();
// Must open and be measured against the floating window when the terminal is popped out there, not the main
// document. `<AnchoredOverlay>` derives both from the anchor, so no pop-out target is passed.
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

const runningCount = computed(() => rows.value.filter((row) => row.running).length);

const openLogs = (row: BackgroundProcessRow): void => {
    open.value = false;
    viewProcessLogs(row);
};
</script>

<template>
    <button
        v-if="rows.length > 0"
        ref="trigger"
        type="button"
        :class="ui.iconButton(`relative`)"
        :aria-expanded="open"
        @click="open = !open"
        v-tooltip.top="'Background processes'"
        aria-label="Background processes"
    >
        <Icon name="cog" class="text-xs" />
        <span v-if="runningCount > 0" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success"></span>
    </button>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="bottom" cross="end">
        <div class="flex w-80 flex-col p-1">
            <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Background processes</div>
            <div v-for="row in rows" :key="row.id" class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-overlay">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="row.running ? 'bg-success' : 'bg-content/25'"></span>
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div v-if="row.extensionId" class="truncate text-2xs text-muted">{{ row.extensionId }}</div>
                </div>
                <button
                    v-if="row.session"
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    @click="openLogs(row)"
                    v-tooltip.top="'View logs (read-only)'"
                    aria-label="View logs"
                >
                    <Icon name="align-left" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && !row.running"
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    :disabled="busy === row.id"
                    @click="start(row)"
                    v-tooltip.top="'Start'"
                    aria-label="Start"
                >
                    <Icon name="play" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && row.running"
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10`)"
                    :disabled="busy === row.id"
                    @click="start(row)"
                    v-tooltip.top="'Restart'"
                    aria-label="Restart"
                >
                    <Icon name="refresh" class="text-2xs" />
                </button>
                <button
                    v-if="row.running || (row.session && !row.extensionId)"
                    type="button"
                    :class="ui.iconButton(`hover:bg-content/10 hover:text-danger`)"
                    :disabled="busy === row.id"
                    @click="stop(row)"
                    v-tooltip.top="'Stop'"
                    aria-label="Stop"
                >
                    <Icon name="stop" class="text-2xs" />
                </button>
            </div>
        </div>
    </AnchoredOverlay>
</template>
