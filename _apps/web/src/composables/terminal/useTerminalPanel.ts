import { TerminalsListSchema } from "@intentic-app/api-contract";
import { ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useLayout } from "../useLayout";
import { useSandbox } from "../sandbox/useSandbox";
import { disposeAllSessions, type TerminalTabsSource } from "./useTerminal";

/* The ONE global terminal panel's controls + session source. Terminals are sandbox-global facts (tmux sessions
 * on one machine), so the panel lives in the shell — below every view — and any surface opens/focuses it with
 * one call: extensions start sessions and `openFocused` them, the workspace toolbar and Ctrl+` toggle it. The
 * daemon's GET /system/terminals is the single tab list: web-* shells (numbered) beside panel-* dev servers
 * (labeled, started via Start) — every tab ×-closable, untracked sessions dimmed. */

export const globalTerminalSource: TerminalTabsSource = {
    list: async () => TerminalsListSchema.parse(await sandboxJson(`/system/terminals`)).sessions,
    create: () => `web-${crypto.randomUUID().slice(0, 8)}`,
    kill: (name) => {
        void sandboxJson(`/system/terminals/${encodeURIComponent(name)}`, { method: `DELETE` });
    },
};

// The focus channel: a fresh object per request, so re-focusing the same session still triggers the panel's
// watch (the shell binds this to TerminalPanel's `initial`).
const requested = ref<{ readonly name: string } | undefined>(undefined);

// The surface channel: like `requested`, but it only relists so the tab appears — it never opens the panel or
// steals the active tab. Used when the agent starts running Bash (its `agent-<id>` terminal should show up
// without hijacking the user's current terminal/view). A fresh object per request re-triggers the watch.
const surfaced = ref<{ readonly name: string } | undefined>(undefined);

// The mounted panel's newTab plus a pending flag for when none is mounted — the global "New Terminal" command
// (useShellCommands) spawns directly into a live panel, else opens the panel and lets its mount consume the
// request. registerTerminalSpawn is called by TerminalPanel with its instance's newTab.
let liveNewTab: (() => void) | undefined;
let pendingSpawn = false;
export const registerTerminalSpawn = (newTab: () => void): (() => void) => {
    liveNewTab = newTab;
    return () => {
        if (liveNewTab === newTab) {
            liveNewTab = undefined;
        }
    };
};
// One-shot read of a spawn that arrived while no panel was mounted (consumed by the panel's onMounted).
export const consumeSpawnRequest = (): boolean => {
    const pending = pendingSpawn;
    pendingSpawn = false;
    return pending;
};

// Cached sockets die with the sandbox they were opened against.
watch(useSandbox().activeSandboxId, () => {
    disposeAllSessions();
    requested.value = undefined;
    surfaced.value = undefined;
});

export function useTerminalPanel() {
    const layout = useLayout();
    const openFocused = (name: string): void => {
        layout.setTerminalOpen(true);
        requested.value = { name };
    };
    // Deliberately does NOT open the panel: a closed panel lists the session anyway on its next open, an open
    // panel relists in place (keeping the active tab).
    const surface = (name: string): void => {
        surfaced.value = { name };
    };
    // Open a brand-new shell tab from anywhere (the "New Terminal" command): straight into a mounted panel,
    // else flag the spawn for the panel that the setOpen brings up.
    const spawnShell = (): void => {
        layout.setTerminalOpen(true);
        if (liveNewTab !== undefined) {
            liveNewTab();
            return;
        }
        pendingSpawn = true;
    };
    return {
        open: layout.terminalOpen,
        setOpen: layout.setTerminalOpen,
        toggle: layout.toggleTerminalVisibility,
        requested,
        surfaced,
        openFocused,
        surface,
        spawnShell,
    };
}
