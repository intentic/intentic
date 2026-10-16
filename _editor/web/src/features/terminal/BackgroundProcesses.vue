<script setup lang="ts">
import { AnchoredOverlay, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { type BackgroundProcessRow, useBackgroundProcesses, viewProcessLogs } from "../../models/terminal/useBackgroundProcesses";
import { useT } from "@intentic/ui/i18n";

// Background-processes control for managed processes, extension gateways, dockerd: status, read-only logs,
// explicit start/stop, not killable terminal tabs. Hidden until there is anything to show.

const t = useT();

const { rows, pressing, failure, dismiss, start, stop } = useBackgroundProcesses();
// Must open and be measured against the floating window when the terminal is popped out there, not the main
// document. `<AnchoredOverlay>` derives both from the anchor, so no pop-out target is passed.
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

const runningCount = computed(() => rows.value.filter((row) => row.running).length);
// A refused start or stop is said on its row, and marked on the trigger, since the popover may be shut when it ends.
const failed = computed(() => rows.value.some((row) => failure(row) !== undefined));

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
        v-tooltip.top="t(`terminal.backgroundProcesses.backgroundProcesses`)"
        :aria-label="t(`terminal.backgroundProcesses.backgroundProcesses`)"
    >
        <Icon name="cog" class="text-xs" />
        <span v-if="failed" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-danger"></span>
        <span v-else-if="runningCount > 0" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-success"></span>
    </button>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="bottom" cross="end">
        <div class="flex w-80 flex-col p-1">
            <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                {{ t(`terminal.backgroundProcesses.backgroundProcesses`) }}
            </div>
            <template v-for="row in rows" :key="row.id">
                <div class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-overlay">
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
                        v-tooltip.top="{ title: t(`ui.action.viewLogs`), note: t(`terminal.backgroundProcesses.readOnly`) }"
                        :aria-label="t(`ui.action.viewLogs`)"
                    >
                        <Icon name="align-left" class="text-2xs" />
                    </button>
                    <button
                        v-if="row.extensionId && !row.running"
                        type="button"
                        :class="ui.iconButton(`hover:bg-content/10`)"
                        :disabled="pressing(row)"
                        @click="start(row)"
                        v-tooltip.top="t(`ui.action.start`)"
                        :aria-label="t(`ui.action.start`)"
                    >
                        <Icon name="play" class="text-2xs" />
                    </button>
                    <button
                        v-if="row.extensionId && row.running"
                        type="button"
                        :class="ui.iconButton(`hover:bg-content/10`)"
                        :disabled="pressing(row)"
                        @click="start(row)"
                        v-tooltip.top="t(`ui.action.restart`)"
                        :aria-label="t(`ui.action.restart`)"
                    >
                        <Icon name="refresh" class="text-2xs" />
                    </button>
                    <button
                        v-if="row.running || (row.session && !row.extensionId)"
                        type="button"
                        :class="ui.iconButton({ tone: `danger` }, `hover:bg-content/10`)"
                        :disabled="pressing(row)"
                        @click="stop(row)"
                        v-tooltip.top="t(`ui.action.stop`)"
                        :aria-label="t(`ui.action.stop`)"
                    >
                        <Icon name="stop" class="text-2xs" />
                    </button>
                </div>
                <div v-if="failure(row) !== undefined" class="flex items-start gap-2 px-2 pb-1.5 pl-6 text-2xs text-danger">
                    <span class="min-w-0 flex-1 break-words">{{ failure(row)!.detail ?? failure(row)!.title }}</span>
                    <button type="button" :class="ui.iconButton(`hover:bg-content/10`)" :aria-label="t(`ui.action.dismiss`)" @click="dismiss(row)">
                        <Icon name="times" class="text-2xs" />
                    </button>
                </div>
            </template>
        </div>
    </AnchoredOverlay>
</template>
