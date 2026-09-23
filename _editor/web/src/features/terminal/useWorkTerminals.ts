import { sandboxRef } from "@intentic/extension-api";
import { computed, type ComputedRef, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { type TerminalSession, useTerminalsQuery } from "./terminalsQuery";
import { importOrReload } from "../../router/staleChunk";

// Work terminals: agent Bash shells and daemon job sessions (including one-shot runs: installs, a project's checks, a
// scaffold), shown by default only through their own surfaces (chat's Bash card, Capabilities page, the popover), not
// tabbed in the panel unless showWorkTerminals is on. `rows` is what is live; `finished` is the jobs that have ended,
// whose pane is the only place their output exists, for as long as the daemon's own sweep keeps them.

const STORAGE_KEY = `ui-work-terminals`;

// How many finished jobs the popover offers. A day of landings is dozens of checks; past the most recent handful the
// answer isn't in a pane any more, it's in the activity the run wrote.
const FINISHED_LIMIT = 6;

// Default off; written directly by every surface that toggles it (Settings, the bar menu, the palette), so nothing
// needs a setter.
export const showWorkTerminals: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

// Conversation title per agent terminal, so a row reads the chat's title instead of `agent-<id>`; a session without one
// just shows its id. Written by the conversation as it surfaces its session; one daemon's sessions, so per sandbox.
const owners = sandboxRef<Record<string, string>>(() => ({}));

export const noteAgentTerminal = (session: string, title: string | null): void => {
    if (title !== null && title !== `` && owners.value[session] !== title) {
        owners.value = { ...owners.value, [session]: title };
    }
};

export interface WorkTerminalRow {
    // tmux session name; the row's identity, and what `open` focuses.
    readonly session: string;
    // Owning conversation's title if noted, else the session's own label.
    readonly name: string;
    readonly kind: "agent" | "job";
    // Epoch ms of last output; 0 when the daemon couldn't say.
    readonly activityAt: number;
}

// Reveals a work terminal as a focused tab regardless of the preference; a plain action so callers with no tab
// machinery can call it. Imports the panel lazily so reading this module doesn't pull in xterm.
export const openWorkTerminal = (session: string): void => {
    importOrReload(
        () => import(`./useTerminalPanel`),
        (module) => module.useTerminalPanel().openFocused(session),
    );
};

const isWork = (session: TerminalSession): session is TerminalSession & { kind: "agent" | "job" } =>
    session.kind === `agent` || session.kind === `job`;

const toRow = (session: TerminalSession & { kind: "agent" | "job" }): WorkTerminalRow => ({
    session: session.name,
    name: owners.value[session.name] ?? session.label ?? session.name,
    kind: session.kind,
    activityAt: session.activityAt,
});

// Most recently active first: recency of output is the only ordering that means anything here.
const byRecency = (left: TerminalSession, right: TerminalSession): number => right.activityAt - left.activityAt;

export function useWorkTerminals(): {
    rows: ComputedRef<WorkTerminalRow[]>;
    finished: ComputedRef<WorkTerminalRow[]>;
    showWorkTerminals: Ref<boolean>;
} {
    const { sessions } = useTerminalsQuery();
    const rows = computed<WorkTerminalRow[]>(() =>
        sessions.value
            .filter(isWork)
            .filter((session) => session.running)
            .toSorted(byRecency)
            .map(toRow),
    );
    // Jobs only. A finished agent shell is already written down in its conversation's transcript, while a check's own
    // output exists nowhere but the pane it ran in, so that pane is worth offering back.
    const finished = computed<WorkTerminalRow[]>(() =>
        sessions.value
            .filter(isWork)
            .filter((session) => !session.running && session.kind === `job`)
            .toSorted(byRecency)
            .slice(0, FINISHED_LIMIT)
            .map(toRow),
    );
    return { rows, finished, showWorkTerminals };
}
