import { computed, type ComputedRef, ref, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { type TerminalSession, useTerminalsQuery } from "./terminalsQuery";

// Work terminals: agent Bash shells and daemon job sessions, shown by default only through their own surfaces (chat's
// Bash card, Capabilities page, the popover), not tabbed in the panel unless showWorkTerminals is on. `rows` lists only
// live ones; a finished pane is already a record elsewhere (transcript, logs) and ages out via the daemon's own sweep.

const STORAGE_KEY = `ui-work-terminals`;

// Default off; written directly by every surface that toggles it (Settings, the bar menu, the palette), so nothing
// needs a setter.
export const showWorkTerminals: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

// Conversation title per agent terminal, so a row reads the chat's title instead of `agent-<id>`; a session without one
// just shows its id. Written by the conversation as it surfaces its session.
const owners = ref<Record<string, string>>({});

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
    void import(`./useTerminalPanel`).then((module) => module.useTerminalPanel().openFocused(session));
};

export function useWorkTerminals(): { rows: ComputedRef<WorkTerminalRow[]>; showWorkTerminals: Ref<boolean> } {
    const { sessions } = useTerminalsQuery();
    const rows = computed<WorkTerminalRow[]>(() =>
        sessions.value
            .filter(
                (session): session is TerminalSession & { kind: "agent" | "job" } =>
                    session.running && (session.kind === `agent` || session.kind === `job`),
            )
            // Most recently active first: recency of output is the only ordering that means anything here.
            .toSorted((left, right) => right.activityAt - left.activityAt)
            .map((session) => ({
                session: session.name,
                name: owners.value[session.name] ?? session.label ?? session.name,
                kind: session.kind,
                activityAt: session.activityAt,
            })),
    );
    return { rows, showWorkTerminals };
}
