import { sandboxRef } from "@intentic/extension-api";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { useLayout } from "../../shell/window/useLayout";
import { listTerminals, refreshTerminals, removeTerminal } from "./terminalsQuery";
import type { TerminalTabsSource } from "./useTerminal";
import { uuid } from "../../lib/uuid";

// Global terminal panel: sandbox-wide tmux sessions, backed by terminalsQuery's shared list so the strip and badge
// agree. A live command's output belongs in a terminal, never a dialog or `<pre>`; a dialog only tracks state and
// offers actions. A frozen transcript record or a settled failure message is text: nothing more is coming.

export const globalTerminalSource: TerminalTabsSource = {
    list: listTerminals,
    create: () => `web-${uuid().slice(0, 8)}`,
    // Removes the row immediately so the badge falls with the tab; refetch in `finally` restores it if the DELETE
    // actually failed. Logged only: the tab's already gone from the strip, and there is no error surface beyond that.
    kill: async (name) => {
        removeTerminal(name);
        try {
            await sandboxRpc.system.killTerminal({ name });
        } catch (error) {
            console.error(`terminal ${name}: kill failed`, error);
        } finally {
            await refreshTerminals();
        }
    },
};

// What a surface asks the panel to open, and what it may say while the tab is on its way. A flow knows what it started;
// the session name means nothing to the user.
export interface TerminalRequest {
    readonly name: string;
    // One line naming what is starting; falls back to the session's own name.
    readonly title?: string;
    // Command behind it, drawn in mono under the title.
    readonly detail?: string;
}

// Focus channel: a fresh object per request, so re-focusing the same session still triggers the panel's watch. Both
// channels name a session on one daemon, so a switch drops what they hold.
const requested = sandboxRef<TerminalRequest | undefined>(() => undefined);

// Relists the tab without opening the panel or stealing the active tab.
const surfaced = sandboxRef<{ readonly name: string } | undefined>(() => undefined);

// Mounted panel's newTab, plus a pending flag for when none is mounted; set via registerTerminalSpawn.
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
// One-shot read of a spawn that arrived while unmounted, consumed by the panel's onMounted.
export const consumeSpawnRequest = (): boolean => {
    const pending = pendingSpawn;
    pendingSpawn = false;
    return pending;
};

// A request is spent once the panel consumes it, so a later mount doesn't replay a stale one. Called by the panel as it
// reads the request.
export const clearTerminalRequest = (): void => {
    requested.value = undefined;
};

export function useTerminalPanel() {
    const layout = useLayout();
    const openFocused = (name: string, about?: Omit<TerminalRequest, `name`>): void => {
        // Sets `requested` before opening so an already-mounting panel observes the transition.
        requested.value = { name, ...about };
        layout.setTerminalOpen(true);
    };
    // Never opens the panel: a closed one lists the session on its next open, an open one relists in place.
    const surface = (name: string): void => {
        surfaced.value = { name };
    };
    // Opens a new shell tab from anywhere: straight into a mounted panel, else flags the spawn for the panel that
    // setOpen brings up.
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
