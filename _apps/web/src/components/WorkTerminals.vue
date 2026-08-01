<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
import Popover from "primevue/popover";
import ToggleSwitch from "primevue/toggleswitch";
import { ref } from "vue";
import { relativeTime } from "../composables/chat/catalog";
import { KIND_ICONS } from "../composables/terminal/terminalMeta";
import { openWorkTerminal, useWorkTerminals, type WorkTerminalRow } from "../composables/terminal/useWorkTerminals";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* The terminal panel's door to work IN PROGRESS: the shells the agent's Bash commands are running in and the
 * sessions the daemon is running its jobs in (a capability add, the infra check), listed HERE instead of tabbing
 * themselves into the strip (see useWorkTerminals for why). Mounted in the panel toolbar beside the
 * background-processes popover it is modelled on, and hidden until something is actually running — so a quiet
 * sandbox never grows a button for it.
 *
 * This is the surface that lets the strip stay clean. Work tabs only while someone is watching it, and while it
 * runs it is always one click away here — named after the conversation that owns it, whatever spoke last on top.
 *
 * Finished work is deliberately absent: a dead pane is not a record (the logs on disk and the transcript are),
 * and a list of them is just the row of corpses the strip was rid of, moved into a popover. That is also why
 * there is no broom here — nothing accumulates for one to sweep, and the daemon ages the dead sessions out on
 * its own (terminal-session.ts reapFinishedSessions). Opening a row reveals it as a tab whichever way the toggle
 * sits — a reveal is an explicit request, and the preference only decides the DEFAULT. There is no Stop, either:
 * killing that shell would take the agent's own command (or the install) with it, so ending one stays the
 * strip's × on a tab the user chose to open. */

const { rows, showWorkTerminals } = useWorkTerminals();
// The popover must open in the floating window while the panel is popped out there, not the main document.
const { overlayTarget } = useTerminalPopout();
const panel = ref<InstanceType<typeof Popover> | null>(null);

const open = (row: WorkTerminalRow): void => {
    panel.value?.hide();
    openWorkTerminal(row.session);
};

// The second line: how long since this said anything — the one thing that separates a turn mid-command from an
// install that has been quiet for twenty minutes. A session tmux gave no stamp for says only that it is running.
const lastOutput = (row: WorkTerminalRow): string => (row.activityAt > 0 ? `running · ${relativeTime(row.activityAt)}` : `running`);
</script>

<template>
    <button
        v-if="rows.length > 0"
        type="button"
        :class="cmp.iconButton()"
        @click="panel?.toggle($event)"
        v-tooltip.top="'Running work'"
        aria-label="Running work"
    >
        <Icon name="wave-pulse" class="text-xs text-link" />
    </button>

    <Popover ref="panel" :append-to="overlayTarget">
        <div class="flex w-80 flex-col p-1">
            <div class="px-2 py-1.5 text-2xs font-medium uppercase tracking-wide text-muted">Running work</div>
            <button
                v-for="row in rows"
                :key="row.session"
                type="button"
                class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-overlay"
                @click="open(row)"
            >
                <!-- Live dot, then the kind glyph — sparkles for an agent's shell, bolt for a daemon job:
                     literally the table their pills read from. -->
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-link"></span>
                <Icon :name="KIND_ICONS[row.kind]" class="shrink-0 text-2xs text-muted" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div class="truncate text-2xs text-muted">{{ lastOutput(row) }}</div>
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
