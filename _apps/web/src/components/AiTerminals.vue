<script setup lang="ts">
import Popover from "primevue/popover";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { type AgentTerminalRow, clearFinishedAgentTerminals, openAgentTerminal, useAgentTerminals } from "../composables/terminal/useAgentTerminals";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* The terminal panel's AI-terminals control: the shells the agent's Bash commands run in, listed HERE instead
 * of tabbing themselves into the strip (see useAgentTerminals for why). Mounted in the panel toolbar beside the
 * background-processes popover it is modelled on, and hidden until there is anything to show — so a sandbox
 * nobody has run an agent in never grows a button for it.
 *
 * This is also where the hiding is discoverable: the footer toggle is the same preference the bar's right-click
 * menu and Settings → Appearance write, offered at the moment someone is already looking for these terminals.
 * Opening a row focuses it as a tab whichever way the toggle sits — a reveal is an explicit request, and the
 * preference only decides the DEFAULT. There is no Stop on a RUNNING row on purpose: killing that shell would
 * take the agent's own command with it, so ending one stays the strip's × on a tab the user chose to open. The
 * header's eraser is the other half — a finished turn's shell is invisible to the strip's sweep now, so the list
 * that shows them is what clears them (the same wording, and the same no-confirm rule: nothing is running). */

const { rows, showAgentTerminals } = useAgentTerminals();
// The popover must open in the floating window while the panel is popped out there, not the main document.
const { overlayTarget } = useTerminalPopout();
const panel = ref<InstanceType<typeof Popover> | null>(null);

const open = (row: AgentTerminalRow): void => {
    panel.value?.hide();
    openAgentTerminal(row.session);
};

const finishedCount = computed(() => rows.value.filter((row) => !row.running).length);
const clearFinishedLabel = computed(() => `Clear ${finishedCount.value} finished terminal${finishedCount.value === 1 ? `` : `s`}`);
</script>

<template>
    <button
        v-if="rows.length > 0"
        type="button"
        class="relative flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
        @click="panel?.toggle($event)"
        v-tooltip.top="'AI terminals'"
        aria-label="AI terminals"
    >
        <Icon name="sparkles" class="text-xs" />
        <span v-if="rows.some((row) => row.running)" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-link"></span>
    </button>

    <Popover ref="panel" :append-to="overlayTarget">
        <div class="flex w-80 flex-col p-1">
            <div class="flex items-center gap-2 px-2 py-1.5">
                <span class="flex-1 text-2xs font-medium uppercase tracking-wide text-muted">AI terminals</span>
                <button
                    v-if="finishedCount > 0"
                    type="button"
                    class="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-danger"
                    @click="void clearFinishedAgentTerminals(rows)"
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
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="row.running ? 'bg-link' : 'bg-content/25'"></span>
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs text-content">{{ row.name }}</div>
                    <div class="truncate text-2xs text-muted">{{ row.running ? `running` : `finished` }} · {{ row.session }}</div>
                </div>
                <Icon name="arrow-up-right" class="shrink-0 text-2xs text-muted" />
            </button>
            <!-- The preference, where the terminals it hides are being looked for. -->
            <label class="mt-1 flex cursor-pointer items-center gap-2.5 border-t border-line px-2 pb-1 pt-2">
                <div class="min-w-0 flex-1">
                    <div class="text-xs text-content">Always show as tabs</div>
                    <div class="text-2xs text-muted">Give every AI terminal its own tab in this panel.</div>
                </div>
                <ToggleSwitch v-model="showAgentTerminals" />
            </label>
        </div>
    </Popover>
</template>
