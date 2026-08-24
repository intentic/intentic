import { computed, type ComputedRef, ref, type Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { type TerminalSession, useTerminalsQuery } from "./terminalsQuery";

/* The surfaces WORK runs on, the agent's shells (`agent-<sdk session>`) and the daemon's job sessions
 * (`job-<flow>`: a capability add, the infra check), as a surface of their own, and the preference that
 * decides whether they also tab in the terminal panel.
 *
 * A work terminal is EVIDENCE about something that ran, not a workspace the user keeps: the transcript already
 * narrates every Bash command and the Capabilities page narrates every install, so the tab earns its place only
 * in the moment someone wants to watch, or type into, the shell it is running in. Tabbing them by default
 * cost the panel its own strip: every turn minted a pill labelled with eight hex characters, every capability
 * left one behind for good, the user's real shells were pushed toward the wrap cap, and what remained was a row
 * of corpses that only a broom cleared. So they are hidden by default and stay one click away instead: the
 * chat's Bash card reveals the turn's own shell, the Capabilities page opens the install it just started, and
 * the panel's work-terminals popover lists whatever is running NOW. `showWorkTerminals` turns the old behaviour
 * back on for whoever wants it.
 *
 * `rows` is live work ONLY. A dead pane is not a record of anything, its bytes are on disk in the terminal
 * logs, its commands are in the transcript, and opening it lands you in a shell that will never say another
 * word. Listing those was just the row of corpses again, moved from the strip into a popover, with a broom
 * beside it to sweep a list nobody asked to keep. So this answers one question, what is running right now,
 * and the sessions themselves age out in the daemon's own sweep (terminal-session.ts reapFinishedSessions),
 * which is what keeps them openable for a while from the surfaces that name one directly.
 *
 * An account preference (composables/preference.ts), like every other panel preference (terminalMeta, the panel
 * height): which tabs you want in front of you is a property of the seat you are sitting at, not of the sandbox,
 * and it holds for every window of the app at that seat, the popped-out terminal included. */

const STORAGE_KEY = `ui-work-terminals`;

// Default off, see the note above. Written directly by every surface that toggles it (the Settings row's
// v-model, the panel's bar menu, the palette command), so nothing needs a setter.
export const showWorkTerminals: Ref<boolean> = definePreference<boolean>({
    key: STORAGE_KEY,
    read: (raw) => raw === `on`,
    write: (value) => (value ? `on` : `off`),
});

/* Which conversation each agent terminal belongs to, so a row can read "Redesign the chat rail" rather than
 * `agent-a1b2c3d4`. Written by the conversation as it surfaces its own session, the same chat → terminal
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
    // The tmux session name, the row's identity, and what `open` focuses.
    readonly session: string;
    // The owning conversation's title when it noted one, else the session's own label.
    readonly name: string;
    readonly kind: "agent" | "job";
    // Epoch ms of the session's last output, "is this still saying anything". 0 when the daemon couldn't say.
    readonly activityAt: number;
}

// Reveal a work terminal as a focused tab, whatever the preference says, the explicit user action the
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

export function useWorkTerminals(): { rows: ComputedRef<WorkTerminalRow[]>; showWorkTerminals: Ref<boolean> } {
    const { sessions } = useTerminalsQuery();
    const rows = computed<WorkTerminalRow[]>(() =>
        sessions.value
            .filter(
                (session): session is TerminalSession & { kind: "agent" | "job" } =>
                    session.running && (session.kind === `agent` || session.kind === `job`),
            )
            // Whatever spoke last, first: with everything here alive, recency of OUTPUT is the only ordering
            // that says anything, the turn that just ran a command sits above the install that has been
            // compiling quietly for ten minutes.
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
