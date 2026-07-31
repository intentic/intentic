<script setup lang="ts">
import Popover from "primevue/popover";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { relativeTime } from "../composables/chat/catalog";
import { KIND_ICONS } from "../composables/terminal/terminalMeta";
import { clearFinishedWorkTerminals, openWorkTerminal, useWorkTerminals, type WorkTerminalRow } from "../composables/terminal/useWorkTerminals";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* The terminal panel's RECORD of work: the shells the agent's Bash commands ran in and the sessions the daemon
 * ran its jobs in (capability adds, the infra check), listed HERE instead of tabbing themselves into the strip
 * (see useWorkTerminals for why). Mounted in the panel
 * toolbar beside the background-processes popover it is modelled on, and hidden until there is anything to
 * show — so a fresh sandbox never grows a button for it.
 *
 * This is the surface that lets the strip stay clean. A finished terminal leaves the tab bar by itself, and
 * everything it did is still one click away here — named, stamped with when it ended and how it exited, newest
 * first. That is the trade the redesign rests on: the panel stops asking the user to sweep up after work they
 * didn't start, and gives them somewhere to look instead.
 *
 * Opening a row reveals it as a tab whichever way the toggle sits — a reveal is an explicit request, and the
 * preference only decides the DEFAULT. There is no Stop on a RUNNING row on purpose: killing that shell would
 * take the agent's own command (or the install) with it, so ending one stays the strip's × on a tab the user
 * chose to open. The header's eraser is the only broom left in the panel, and it needs no confirmation: nothing
 * it takes is running, and every pane's output is already on disk in the terminal logs. It is a convenience
 * anyway — the daemon ages these out on its own (terminal-session.ts reapFinishedSessions). */

const { rows, showWorkTerminals } = useWorkTerminals();
// The popover must open in the floating window while the panel is popped out there, not the main document.
const { overlayTarget } = useTerminalPopout();
const panel = ref<InstanceType<typeof Popover> | null>(null);

const open = (row: WorkTerminalRow): void => {
    panel.value?.hide();
    openWorkTerminal(row.session);
};

const finishedCount = computed(() => rows.value.filter((row) => !row.running).length);
const clearFinishedLabel = computed(() => `Clear ${finishedCount.value} finished terminal${finishedCount.value === 1 ? `` : `s`}`);

// The second line of a row: what happened, and when. A running one is still happening, so it says only that.
// An exit code the daemon couldn't read (tmux reported none) is left out rather than guessed at — when it ended
// is the useful half, and "exit undefined" would be worse than silence.
const outcome = (row: WorkTerminalRow): string => {
    if (row.running) {
        return `running`;
    }
    const ended = row.exitCode === undefined ? `finished` : `exit ${row.exitCode}`;
    return row.activityAt > 0 ? `${ended} · ${relativeTime(row.activityAt)}` : ended;
};
// Failure is the one thing worth colouring: a non-zero exit is the row someone came here to find.
const failed = (row: WorkTerminalRow): boolean => !row.running && row.exitCode !== undefined && row.exitCode !== 0;
</script>

<template>
    <button
        v-if="rows.length > 0"
        type="button"
        class="relative flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
        @click="panel?.toggle($event)"
        v-tooltip.top="'Recent work'"
        aria-label="Recent work"
    >
        <Icon name="history" class="text-xs" />
        <span v-if="rows.some((row) => row.running)" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-link"></span>
    </button>

    <Popover ref="panel" :append-to="overlayTarget">
        <div class="flex w-80 flex-col p-1">
            <div class="flex items-center gap-2 px-2 py-1.5">
                <span class="flex-1 text-2xs font-medium uppercase tracking-wide text-muted">Recent work</span>
                <button
                    v-if="finishedCount > 0"
                    type="button"
                    class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-danger"
                    @click="void clearFinishedWorkTerminals(rows)"
                    v-tooltip.top="clearFinishedLabel"
                    :aria-label="clearFinishedLabel"
                >
                    <Icon name="eraser" class="text-2xs" />
                </button>
            </div>
            <button
                v-for="row in rows"
                :key="row.session"
                type="button"
                class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
                @click="open(row)"
            >
                <!-- Dot for state (live / failed / done), then the kind glyph — sparkles for an agent's
                     shell, bolt for a daemon job: literally the table their pills read from. -->
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="row.running ? 'bg-link' : failed(row) ? 'bg-danger' : 'bg-content/25'"></span>
                <Icon :name="KIND_ICONS[row.kind]" class="shrink-0 text-2xs text-muted" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div class="truncate text-2xs" :class="failed(row) ? 'text-danger' : 'text-muted'">{{ outcome(row) }}</div>
                </div>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
            </button>
            <!-- The preference, where the terminals it hides are being looked for. -->
            <label class="mt-1 flex cursor-pointer items-center gap-2.5 border-t border-line px-2 pb-1 pt-2">
                <div class="min-w-0 flex-1">
                    <div class="text-xs text-content">Always show as tabs</div>
                    <div class="text-2xs text-muted">Give every agent shell and job its own tab in this panel.</div>
                </div>
                <ToggleSwitch v-model="showWorkTerminals" />
            </label>
        </div>
    </Popover>
</template>
