<script setup lang="ts">
import { AnchoredOverlay, timeAgo, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { KINDS } from "./terminalMeta";
import { openWorkTerminal, useWorkTerminals, type WorkTerminalRow } from "./useWorkTerminals";
import { useT } from "@intentic/ui/i18n";

// Popover listing work in progress (agent Bash shells, daemon job sessions, one-shot runs) instead of tabbing into the
// strip, and under it the jobs that have just ended: a finished check is the one whose pane you want, and it leaves the
// strip the moment you look away. Hidden until there is something to say. Revealing a row tabs it; there is no Stop here.

const t = useT();

const { rows, finished } = useWorkTerminals();
// Anchored, not a Popover, so the overlay follows a popped-out terminal window instead of its edge.
const trigger = ref<HTMLButtonElement | null>(null);
const panelOpen = ref(false);
// Nothing running is a different claim from nothing to show: the button stays for the finished rows, unlit.
const live = computed(() => rows.value.length > 0);

const open = (row: WorkTerminalRow): void => {
    panelOpen.value = false;
    openWorkTerminal(row.session);
};

// Time since last output, the one signal that separates a mid-command turn from a quietly-compiling install; no stamp
// just means running.
const lastOutput = (row: WorkTerminalRow): string => (row.activityAt > 0 ? `running · ${timeAgo(row.activityAt, { days: true })}` : `running`);
// A finished job's last output is when it ended, since the pane went quiet with it.
const endedAt = (row: WorkTerminalRow): string => (row.activityAt > 0 ? `finished · ${timeAgo(row.activityAt, { days: true })}` : `finished`);
</script>

<template>
    <button
        v-if="live || finished.length > 0"
        ref="trigger"
        type="button"
        :class="ui.iconButton()"
        :aria-expanded="panelOpen"
        @click="panelOpen = !panelOpen"
        v-tooltip.top="t(`terminal.words.workTerminals`)"
        :aria-label="t(`terminal.words.workTerminals`)"
    >
        <Icon name="wave-pulse" class="text-xs" :class="live ? 'text-link' : 'text-muted'" />
    </button>

    <AnchoredOverlay v-model="panelOpen" :anchor="trigger ?? undefined" side="bottom" cross="end">
        <div class="flex w-80 flex-col p-1">
            <div v-if="live" class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                {{ t(`shared.running`) }}
            </div>
            <button
                v-for="row in rows"
                :key="row.session"
                type="button"
                class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
                @click="open(row)"
            >
                <!-- Live dot, then the kind glyph (sparkles for an agent shell, bolt for a job), from the same table the pills use. -->
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-link"></span>
                <Icon :name="KINDS[row.kind].icon" class="shrink-0 text-2xs text-muted" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div class="truncate text-2xs text-muted">{{ lastOutput(row) }}</div>
                </div>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
            </button>
            <!--
                What just ran: kept out of the strip, kept within reach. The row goes when the daemon reaps the session, so what is offered here can
                always still be opened.
            -->
            <div
                v-if="finished.length > 0"
                class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted"
                :class="live ? 'mt-1 border-t border-line-subtle pt-2' : undefined"
            >
                {{ t(`terminal.workTerminals.finished`) }}
            </div>
            <button
                v-for="row in finished"
                :key="row.session"
                type="button"
                class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
                @click="open(row)"
            >
                <!-- Hollow dot against the live one above: same row, spent. -->
                <span class="h-1.5 w-1.5 shrink-0 rounded-full border border-subtle"></span>
                <Icon :name="KINDS[row.kind].icon" class="shrink-0 text-2xs text-subtle" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-muted">{{ row.name }}</div>
                    <div class="truncate text-2xs text-subtle">{{ endedAt(row) }}</div>
                </div>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
            </button>
        </div>
    </AnchoredOverlay>
</template>
