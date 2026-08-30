import { ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useLayout } from "../useLayout";
import { useSandbox } from "../sandbox/useSandbox";
import { clearPendingTerminals, listTerminals, refreshTerminals, removeTerminal } from "./terminalsQuery";
import { disposeAllSessions, type TerminalTabsSource } from "./useTerminal";
import { uuid } from "../uuid";

/* The ONE global terminal panel's controls + session source. Terminals are sandbox-global facts (tmux sessions
 * on one machine), so the panel lives in the shell, below every view, and any surface opens/focuses it with
 * one call: extensions start sessions and `openFocused` them, the rail's terminal button and Ctrl+` toggle it. The
 * daemon's GET /system/terminals is the single tab list: web-* shells (numbered) beside panel-* dev servers
 * (labeled, started via Start), every tab ×-closable, untracked sessions dimmed. It is read through
 * terminalsQuery's shared cache entry, so the strip and the rail's badge are literally the same list.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE A COMMAND'S OUTPUT GOES, the browser half of the rule terminal/terminal-run.ts states for the daemon
 * ("every real shell action the daemon executes for a user-triggered flow runs inside a visible tmux session").
 * Written here because this module is the only way to reach that session, so this is where a surface decides.
 *
 *   A LIVE COMMAND'S OUTPUT IS A TERMINAL. `openFocused(session)` and nothing else. Not a <pre>, not a scrolling
 *   box, not a polled tail. A terminal has colour, interprets the carriage returns a runner uses to rewrite its
 *   own progress line, scrolls back through the part that went past, and can be typed into; a box has none of
 *   that and cannot even render the escape codes, so a suite's failure arrives wearing `[39m[22m` litter.
 *
 *   A DIALOG TRACKS STATE AND OFFERS ACTIONS. What is being asked, how the run ended, and the buttons, no
 *   output. Which is also why such a dialog is not modal: a mask would dim and freeze the terminal the user was
 *   just sent to watch (see the push flow in pages/workspace/ReviewPanel.vue, the worked example).
 *
 * TWO THINGS THAT LOOK LIKE THE RULE'S VIOLATION AND ARE NOT, do not "fix" these:
 *   · A TRANSCRIPT'S RECORD of a tool result (chat/ChatToolCard.vue's command body). That box is what the MODEL
 *     saw, frozen in the conversation, and it has to stay readable a week later when the tmux session is long
 *     reaped. It carries a "Watch in terminal" button to the live session, which is the pairing to copy.
 *   · A SETTLED FAILURE MESSAGE, a command's final words, bounded and actionable (components/VpnCard.vue's
 *     dial failure, which names the exact certificate digest to pin). That is a notice, and notices are text.
 * The line between them: is there more of it coming? Then it is a terminal.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export const globalTerminalSource: TerminalTabsSource = {
    list: listTerminals,
    create: () => `web-${uuid().slice(0, 8)}`,
    // Drop it from the shared list up front so the rail's badge falls with the tab, then let the daemon's own
    // account of the kill land, which is what puts the session BACK if the DELETE turns out to have failed.
    // That reconcile is the whole point, so it runs in a `finally`: a tunnel that drops mid-kill is exactly the
    // case the optimistic removal has to be walked back for, and a refresh only reached on success would leave
    // the rail under-counting a shell that is still up until the next poll.
    //
    // The failure stops here rather than riding out of a promise nobody awaits (the tab left the strip
    // synchronously, see TerminalTabsSource.kill). One line of console is all there is to say: the list above
    // has already told the user the truth, and the panel has no error surface that a dead tunnel wouldn't
    // already be shouting from.
    kill: async (name) => {
        removeTerminal(name);
        try {
            await sandboxJson(`/system/terminals/${encodeURIComponent(name)}`, { method: `DELETE` });
        } catch (error) {
            console.error(`terminal ${name}: kill failed`, error);
        } finally {
            await refreshTerminals();
        }
    },
};

/* What a surface asks the panel to open, and what it may say about it while the tab is on its way. A flow
 * knows what it started ("Running your pre-push check") and the app does not, the session name is an internal
 * one, and "Opening job-checks…" is the whole of what a waiting panel used to be able to say for itself. */
export interface TerminalRequest {
    readonly name: string;
    // One line naming what is starting. Falls back to the session's own name where a caller has nothing better.
    readonly title?: string;
    // The command behind it, drawn in mono under the title.
    readonly detail?: string;
}

// The focus channel: a fresh object per request, so re-focusing the same session still triggers the panel's
// watch (the shell binds this to TerminalPanel's `initial`).
const requested = ref<TerminalRequest | undefined>(undefined);

// The surface channel: like `requested`, but it only relists so the tab appears, it never opens the panel or
// steals the active tab. Used when the agent starts running Bash (its `agent-<id>` terminal should show up
// without hijacking the user's current terminal/view). A fresh object per request re-triggers the watch.
const surfaced = ref<{ readonly name: string } | undefined>(undefined);

// The mounted panel's newTab plus a pending flag for when none is mounted, the global "New Terminal" command
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

// Cached sockets, and the claims on names not yet listed, die with the sandbox they were opened against. That
// sandbox is named on the way out, so the scrollback each session leaves behind is filed where it will be found
// again: this watch runs after the active id has already changed.
watch(useSandbox().activeSandboxId, (_id, previous) => {
    disposeAllSessions(previous);
    clearPendingTerminals();
    requested.value = undefined;
    surfaced.value = undefined;
});

/* A request is SPENT once the panel has taken it. It used to stand forever, so the next panel to mount,
 * hours later, by Ctrl+`, a float, a mobile route change, replayed it and went hunting for whatever
 * yesterday's push had been running. That is where "Opening job-checks…" came from when nobody was pushing.
 * Called by the panel as it consumes the request, which is the only reader there is. */
export const clearTerminalRequest = (): void => {
    requested.value = undefined;
};

export function useTerminalPanel() {
    const layout = useLayout();
    const openFocused = (name: string, about?: Omit<TerminalRequest, `name`>): void => {
        // Publish WHY the panel is opening before opening it. Vue normally batches these writes, but the panel
        // can already be mounting (a restored open state, another window-state edge), and its attach path has a
        // real empty-panel default: create shell "1". Giving the target the earlier state transition makes a
        // mount observe the request immediately; useTerminal's live `pending` guard covers one already awaiting
        // its first list.
        requested.value = { name, ...about };
        layout.setTerminalOpen(true);
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
