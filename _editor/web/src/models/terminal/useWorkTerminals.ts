import { sandboxRef } from "@intentic/extension-api";
import { computed, type ComputedRef } from "vue";
import { isWork } from "./terminalMeta";
import { type TerminalSession, useTerminalsQuery } from "./terminalsQuery";
import { importOrReload } from "../../lib/staleChunk";

// Work terminals: agent Bash shells and daemon job sessions (including one-shot runs: installs, a project's checks, a
// scaffold), shown through their own surfaces (chat's Bash card, Capabilities page, the popover), and
// tabbed in the panel only when explicitly revealed. `rows` is what is live; `finished` is the jobs that have ended,
// whose pane is the only place their output exists, for as long as the daemon's own sweep keeps them.

// How many finished jobs the popover offers. A day of landings is dozens of checks; past the most recent handful the
// answer isn't in a pane any more, it's in the activity the run wrote.
const FINISHED_LIMIT = 6;

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

// Reveals a work terminal as a focused tab; a plain action so callers with no tab
// machinery can call it. Imports the panel lazily so reading this module doesn't pull in xterm.
export const openWorkTerminal = (session: string): void => {
    importOrReload(
        () => import(`./useTerminalPanel`),
        (module) => module.useTerminalPanel().openFocused(session),
    );
};

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
    return { rows, finished };
}
