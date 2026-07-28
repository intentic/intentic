import { computed, type ComputedRef, ref, type Ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { refreshTerminals, removeTerminal, useTerminalsQuery } from "./terminalsQuery";

/* The agent's live shells (`agent-<sdk session>`) as a surface of their own, and the preference that decides
 * whether they also tab in the terminal panel.
 *
 * An agent terminal is EVIDENCE about a turn, not a workspace the user keeps: the transcript already narrates
 * every Bash command, so the tab earns its place only in the rare moment someone wants to watch — or type
 * into — the shell it is running in. Tabbing every one of them by default cost the panel its own strip: each
 * turn minted a pill labelled with eight hex characters, pushed the user's real shells toward the wrap cap,
 * and left a dimmed corpse behind that only the sweep cleared. So the default is OFF, and the terminals stay
 * one click away instead: the chat's Bash card reveals the turn's own shell, and the panel's popover lists
 * whatever is live. `showAgentTerminals` turns the old behaviour back on for whoever wants it.
 *
 * Per-browser (localStorage), like every other panel preference (terminalMeta, the panel height): which tabs
 * you want in front of you is a property of the seat you are sitting at, not of the sandbox. */

const STORAGE_KEY = `ui-agent-terminals`;

const read = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) === `on`;
    } catch {
        // Storage may be unavailable (private mode); fall back to the default.
        return false;
    }
};

// Default off — see the note above. Written directly by every surface that toggles it (the Settings row's
// v-model, the panel's bar menu, the palette command), so nothing needs a setter.
export const showAgentTerminals: Ref<boolean> = ref(read());

watch(showAgentTerminals, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value ? `on` : `off`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

/* Which conversation each agent terminal belongs to, so a row can read "Redesign the chat rail" rather than
 * `agent-a1b2c3d4`. Written by the conversation as it surfaces its own session — the same chat → terminal
 * direction the surface call already runs in, so listing these costs the terminal layer no import of the chat
 * model. A title only ever improves: a session whose owner never wrote one still shows its id. */
const owners = ref<Record<string, string>>({});

export const noteAgentTerminal = (session: string, title: string | null): void => {
    if (title !== null && title !== `` && owners.value[session] !== title) {
        owners.value = { ...owners.value, [session]: title };
    }
};

export interface AgentTerminalRow {
    // The tmux session name — the row's identity, and what `open` focuses.
    readonly session: string;
    // The owning conversation's title when it noted one, else the session's short id.
    readonly name: string;
    // False for a finished turn's lingering shell (its output still in scrollback).
    readonly running: boolean;
}

// Tighter than the rail badge's poll, looser than the process rows': the popover is read while a turn runs, so
// a shell that appears mid-turn should show up without a long wait, but nothing here has a button whose state
// the user is watching for confirmation.
const POLL_MS = 5000;

// Reveal an agent terminal as a focused tab, whatever the preference says — the explicit user action the
// hidden-by-default rule exists to be overridden by (the chat's Bash card, the popover's rows). Plain action
// rather than composable state, so a surface with no tab machinery can call it; useTerminal's `focus` is what
// remembers the reveal for the panel's lifetime.
//
// The panel is imported LAZILY, so reading this module costs no xterm: the preference is read by Settings and
// the chat's tool cards, neither of which should pull the terminal chain into its chunk. Same reason
// conversation.ts reaches the panel this way.
export const openAgentTerminal = (session: string): void => {
    void import(`./useTerminalPanel`).then((module) => module.useTerminalPanel().openFocused(session));
};

/* Kill the shells of finished turns. The panel's own sweep can only take tabs it can SEE, so hiding these by
 * default would otherwise let a sandbox silt up with dead tmux sessions nobody could reach — the popover that
 * lists them owns the broom. Only finished rows go: a running one is carrying the agent's own command.
 *
 * Each kill drops off the shared list the moment it is issued (the strip's rule — see removeTerminal), and the
 * daemon's account of all of them lands once at the end, which is what puts anything back that failed. */
export const clearFinishedAgentTerminals = async (rows: readonly AgentTerminalRow[]): Promise<void> => {
    const finished = rows.filter((row) => !row.running);
    for (const row of finished) {
        removeTerminal(row.session);
    }
    await Promise.all(
        finished.map(async (row) => {
            try {
                await sandboxJson(`/system/terminals/${encodeURIComponent(row.session)}`, { method: `DELETE` });
            } catch (error) {
                console.error(`terminal ${row.session}: kill failed`, error);
            }
        }),
    );
    await refreshTerminals();
};

export function useAgentTerminals(): { rows: ComputedRef<AgentTerminalRow[]>; showAgentTerminals: Ref<boolean> } {
    const { sessions } = useTerminalsQuery(POLL_MS);
    const rows = computed<AgentTerminalRow[]>(() =>
        sessions.value
            .filter((session) => session.kind === `agent`)
            // Live turns first: a running shell is the one someone opening this is looking for.
            .toSorted((left, right) => Number(right.running) - Number(left.running))
            .map((session) => ({
                session: session.name,
                name: owners.value[session.name] ?? session.label ?? session.name,
                running: session.running,
            })),
    );
    return { rows, showAgentTerminals };
}
