<script setup lang="ts">
import { cmp } from "@intentic/ui";
import Popover from "primevue/popover";
import { computed, ref } from "vue";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "../composables/terminal/useBackgroundProcesses";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* The terminal panel's background-processes control (pm2-style): managed processes — extension gateways,
 * dockerd — surface HERE with status, read-only log views, and explicit start/stop, not as killable terminal
 * tabs, so a stray tab × can't take an automation's gateway down. Mounted in the panel toolbar; hidden until
 * there is anything to show.
 *
 * The power-user shortcut, NOT the canonical surface: an extension's process also renders on the capability
 * card its connector belongs to, which is where someone asking "why did my bot stop answering?" actually
 * looks. Same rows, same actions — useBackgroundProcesses owns both. */

const { rows, busy, start, stop } = useBackgroundProcesses();
// The popover must open in the floating window while the panel is popped out there, not the main document.
const { overlayTarget } = useTerminalPopout();
const panel = ref<InstanceType<typeof Popover> | null>(null);

const runningCount = computed(() => rows.value.filter((row) => row.running).length);

const openLogs = (row: BackgroundProcessRow): void => {
    panel.value?.hide();
    viewProcessLogs(row);
};
</script>

<template>
    <button
        v-if="rows.length > 0"
        type="button"
        :class="cmp.iconButton(`relative`)"
        @click="panel?.toggle($event)"
        v-tooltip.top="'Background processes'"
        aria-label="Background processes"
    >
        <Icon name="cog" class="text-xs" />
        <span v-if="runningCount > 0" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success"></span>
    </button>

    <Popover ref="panel" :append-to="overlayTarget">
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
                    :class="cmp.iconButton(`hover:bg-content/10`)"
                    @click="openLogs(row)"
                    v-tooltip.top="'View logs (read-only)'"
                    aria-label="View logs"
                >
                    <Icon name="align-left" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && !row.running"
                    type="button"
                    :class="cmp.iconButton(`hover:bg-content/10`)"
                    :disabled="busy === row.id"
                    @click="void start(row)"
                    v-tooltip.top="'Start'"
                    aria-label="Start"
                >
                    <Icon name="play" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && row.running"
                    type="button"
                    :class="cmp.iconButton(`hover:bg-content/10`)"
                    :disabled="busy === row.id"
                    @click="void start(row)"
                    v-tooltip.top="'Restart'"
                    aria-label="Restart"
                >
                    <Icon name="refresh" class="text-2xs" />
                </button>
                <button
                    v-if="row.running || (row.session && !row.extensionId)"
                    type="button"
                    :class="cmp.iconButton(`hover:bg-content/10 hover:text-danger`)"
                    :disabled="busy === row.id"
                    @click="void stop(row)"
                    v-tooltip.top="'Stop'"
                    aria-label="Stop"
                >
                    <Icon name="stop" class="text-2xs" />
                </button>
            </div>
        </div>
    </Popover>
</template>
