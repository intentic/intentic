<script setup lang="ts">
import { AnchoredOverlay, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { ref } from "vue";
import { relativeTime } from "../chat/models/catalog";
import { KIND_ICONS } from "./terminalMeta";
import { openWorkTerminal, useWorkTerminals, type WorkTerminalRow } from "./useWorkTerminals";

// Popover listing work in progress (agent Bash shells, daemon job sessions) instead of tabbing into the strip; hidden
// until something runs. No finished work: a dead pane isn't a record, and the daemon reaps it on its own. Revealing a
// row tabs it regardless of the preference; there is no Stop here.

const { rows, showWorkTerminals } = useWorkTerminals();
// Anchored, not a Popover, so the overlay follows a popped-out terminal window instead of its edge.
const trigger = ref<HTMLButtonElement | null>(null);
const panelOpen = ref(false);

const open = (row: WorkTerminalRow): void => {
    panelOpen.value = false;
    openWorkTerminal(row.session);
};

// Time since last output, the one signal that separates a mid-command turn from a quietly-compiling install; no stamp
// just means running.
const lastOutput = (row: WorkTerminalRow): string => (row.activityAt > 0 ? `running · ${relativeTime(row.activityAt)}` : `running`);
</script>

<template>
    <button
        v-if="rows.length > 0"
        ref="trigger"
        type="button"
        :class="ui.iconButton()"
        :aria-expanded="panelOpen"
        @click="panelOpen = !panelOpen"
        v-tooltip.top="'Running work'"
        aria-label="Running work"
    >
        <Icon name="wave-pulse" class="text-xs text-link" />
    </button>

    <AnchoredOverlay v-model="panelOpen" :anchor="trigger ?? undefined" side="bottom" cross="end">
        <div class="flex w-80 flex-col p-1">
            <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Running work</div>
            <button
                v-for="row in rows"
                :key="row.session"
                type="button"
                class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
                @click="open(row)"
            >
                <!-- Live dot, then the kind glyph (sparkles for an agent shell, bolt for a job), from the same table the pills use. -->
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-link"></span>
                <Icon :name="KIND_ICONS[row.kind]" class="shrink-0 text-2xs text-muted" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div class="truncate text-2xs text-muted">{{ lastOutput(row) }}</div>
                </div>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
            </button>
            <!-- The preference for where hidden terminals reappear as tabs. -->
            <label class="mt-1 flex cursor-pointer items-center gap-2.5 border-t border-line-subtle px-2 pb-1 pt-2">
                <div class="min-w-0 flex-1">
                    <div class="text-xs text-content">Always show as tabs</div>
                    <div class="text-2xs text-muted">Give every agent shell and job its own tab in this panel.</div>
                </div>
                <ToggleSwitch v-model="showWorkTerminals" />
            </label>
        </div>
    </AnchoredOverlay>
</template>
