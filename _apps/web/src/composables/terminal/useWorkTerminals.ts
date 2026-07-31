import { computed, type ComputedRef, ref, type Ref, watch } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { refreshTerminals, removeTerminal, type TerminalSession, useTerminalsQuery } from "./terminalsQuery";

/* The surfaces WORK runs on — the agent's shells (`agent-<sdk session>`) and the daemon's job sessions
 * (`job-<flow>`: a capability add, the infra check) — as a surface of their own, and the preference that
 * decides whether they also tab in the terminal panel.
 *
 * A work terminal is EVIDENCE about something that ran, not a workspace the user keeps: the transcript already
 * narrates every Bash command and the Capabilities page narrates every install, so the tab earns its place only
 * in the moment someone wants to watch — or type into — the shell it is running in. Tabbing them by default
 * cost the panel its own strip: every turn minted a pill labelled with eight hex characters, every capability
 * left one behind for good, the user's real shells were pushed toward the wrap cap, and what remained was a row
 * of corpses that only a broom cleared. So they are hidden by default and stay one click away instead: the
 * chat's Bash card reveals the turn's own shell, the Capabilities page opens the install it just started, and
 * the panel's Recent-terminals popover lists whatever has run lately. `showWorkTerminals` turns the old
 * behaviour back on for whoever wants it.
 *
 * Per-browser (localStorage), like every other panel preference (terminalMeta, the panel height): which tabs
 * you want in front of you is a property of the seat you are sitting at, not of the sandbox. */

const STORAGE_KEY = `ui-work-terminals`;

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
export const showWorkTerminals: Ref<boolean> = ref(read());

watch(showWorkTerminals, (value) => {
    try {
        localStorage.setItem(STORAGE_KEY, value ? `on` : `off`);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
});

/* Which conversation each agent terminal belongs to, so a row can read "Redesign the chat rail" rather than
 * `agent-a1b2c3d4`. Written by the conversation as it surfaces its own session — the same chat → terminal
 * direction the surface call already runs in, so listing these costs the terminal layer no import of the chat
 * model. A title only ever improves: a session whose owner never wrote one still shows its id. (Job sessions
 * need no such table: `job-capability-demo` is already the name of the thing that ran.) */
const owners = ref<Record<string, string>>({});

export const noteAgentTerminal = (session: string, title: string | null): void => {
    if (title !== null && title !== `` && owners.value[session] !== title) {
        owners.value = { ...owners.value, [session]: title };
    }
};

export interface WorkTerminalRow {
    // The tmux session name — the row's identity, and what `open` focuses.
    readonly session: string;
    // The owning conversation's title when it noted one, else the session's own label.
    readonly name: string;
    readonly kind: "agent" | "job";
    // False for a finished turn's (or flow's) lingering shell, its output still in scrollback.
    readonly running: boolean;
    // The last command's exit status. Undefined while it runs, and on a session tmux reported none for.
    readonly exitCode: number | undefined;
    // Epoch ms of the session's last output — "how long ago did this finish". 0 when the daemon couldn't say.
    readonly activityAt: number;
}

// Tighter than the rail badge's poll, looser than the process rows': the popover is read while a turn runs, so
// a shell that appears mid-turn should show up without a long wait, but nothing here has a button whose state
// the user is watching for confirmation.
const POLL_MS = 5000;

// Reveal a work terminal as a focused tab, whatever the preference says — the explicit user action the
// hidden-by-default rule exists to be overridden by (the chat's Bash card, the popover's rows, the Capabilities
// page's running install). Plain action rather than composable state, so a surface with no tab machinery can
// call it; useTerminal's `focus` is what remembers the reveal for as long as it is worth remembering.
//
// The panel is imported LAZILY, so reading this module costs no xterm: the preference is read by Settings and
// the chat's tool cards, neither of which should pull the terminal chain into its chunk. Same reason
// conversation.ts reaches the panel this way.
export const openWorkTerminal = (session: string): void => {
    void import(`./useTerminalPanel`).then((module) => module.useTerminalPanel().openFocused(session));
};

/* Kill the sessions of finished work. The strip no longer tabs these at all, so the list that shows them owns
 * the broom — and it is the only broom left: with nothing accumulating in the strip there is nothing there to
 * sweep. Only finished rows go; a running one is carrying the agent's own command or a live install.
 *
 * Rarely needed, since the daemon ages these out by itself (terminal-session.ts reapFinishedSessions). It is
 * here for the user who wants the sandbox tidy NOW, and it asks nothing first: every pane's bytes are already
 * on disk in the terminal logs, so this costs precisely nothing.
 *
 * Each kill drops off the shared list the moment it is issued (the strip's rule — see removeTerminal), and the
 * daemon's account of all of them lands once at the end, which is what puts anything back that failed. */
export const clearFinishedWorkTerminals = async (rows: readonly WorkTerminalRow[]): Promise<void> => {
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

export function useWorkTerminals(): { rows: ComputedRef<WorkTerminalRow[]>; showWorkTerminals: Ref<boolean> } {
    const { sessions } = useTerminalsQuery(POLL_MS);
    const rows = computed<WorkTerminalRow[]>(() =>
        sessions.value
            .filter(
                (session): session is TerminalSession & { kind: "agent" | "job" } => session.kind === `agent` || session.kind === `job`,
            )
            // Live work first — it's what someone opening this is looking for — then the most recently finished,
            // because a record is read newest-first and the tail of the list is the part nobody wants.
            .toSorted((left, right) => Number(right.running) - Number(left.running) || right.activityAt - left.activityAt)
            .map((session) => ({
                session: session.name,
                name: owners.value[session.name] ?? session.label ?? session.name,
                kind: session.kind,
                running: session.running,
                exitCode: session.exitCode,
                activityAt: session.activityAt,
            })),
    );
    return { rows, showWorkTerminals };
}
