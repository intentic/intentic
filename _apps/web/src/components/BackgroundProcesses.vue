<script setup lang="ts">
import Popover from "primevue/popover";
import { computed, ref } from "vue";
import { type BackgroundProcessRow, useBackgroundProcesses } from "../composables/terminal/useBackgroundProcesses";
import type { TerminalTabs } from "../composables/terminal/useTerminal";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* The terminal panel's background-processes control (pm2-style): managed processes — extension gateways,
 * dockerd — surface HERE with status, read-only log views, and explicit start/stop, not as killable terminal
 * tabs, so a stray tab × can't take an automation's gateway down. Mounted in the panel toolbar; hidden until
 * there is anything to show. */

const { tabs } = defineProps<{ tabs: TerminalTabs }>();

const { rows, start, stop } = useBackgroundProcesses(tabs);
// The popover must open in the floating window while the panel is popped out there, not the main document.
const { overlayTarget } = useTerminalPopout();
const panel = ref<InstanceType<typeof Popover> | null>(null);
// The row an action is in flight for — its buttons disable so a double-click can't double-restart.
const busy = ref<string | undefined>(undefined);

const runningCount = computed(() => rows.value.filter((row) => row.running).length);

const act = async (row: BackgroundProcessRow, action: (row: BackgroundProcessRow) => Promise<void>): Promise<void> => {
    busy.value = row.id;
    try {
        await action(row);
    } finally {
        busy.value = undefined;
    }
};

const viewLogs = async (row: BackgroundProcessRow): Promise<void> => {
    if (row.session !== undefined) {
        panel.value?.hide();
        await tabs.viewProcess(row.session);
    }
};
</script>

<template>
    <button
        v-if="rows.length > 0"
        type="button"
        class="relative flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
        @click="panel?.toggle($event)"
        v-tooltip.top="'Background processes'"
        aria-label="Background processes"
    >
        <Icon name="cog" class="text-xs" />
        <span v-if="runningCount > 0" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success"></span>
    </button>

    <Popover ref="panel" :append-to="overlayTarget" @show="void tabs.refresh()">
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
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-content/10 hover:text-content"
                    @click="void viewLogs(row)"
                    v-tooltip.top="'View logs (read-only)'"
                    aria-label="View logs"
                >
                    <Icon name="align-left" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && !row.running"
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-content/10 hover:text-content"
                    :disabled="busy === row.id"
                    @click="void act(row, start)"
                    v-tooltip.top="'Start'"
                    aria-label="Start"
                >
                    <Icon name="play" class="text-2xs" />
                </button>
                <button
                    v-if="row.extensionId && row.running"
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-content/10 hover:text-content"
                    :disabled="busy === row.id"
                    @click="void act(row, start)"
                    v-tooltip.top="'Restart'"
                    aria-label="Restart"
                >
                    <Icon name="refresh" class="text-2xs" />
                </button>
                <button
                    v-if="row.running || (row.session && !row.extensionId)"
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-content/10 hover:text-danger"
                    :disabled="busy === row.id"
                    @click="void act(row, stop)"
                    v-tooltip.top="'Stop'"
                    aria-label="Stop"
                >
                    <Icon name="stop" class="text-2xs" />
                </button>
            </div>
        </div>
    </Popover>
</template>
