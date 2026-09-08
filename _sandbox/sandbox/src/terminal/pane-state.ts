// What the daemon reads off tmux's panes, shared by the terminals list (system.routes.ts) and the runtime sampler
// (runtime-watch.ts), so the two can never disagree about a session's state. Sharing the format string and the fold
// rules out that class of drift.

// The one list-panes -F line both readers parse; one line per pane, so a multi-window session reports many.
export const PANE_FORMAT = "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}\t#{pane_current_command}";

// The image's default shell; pane_current_command reads this at idle, which `foreground` reads as not busy.
export const SHELL = "zsh";

// One row per session: live if any pane is; command/exitCode come from the last pane (a corpse once it finishes);
// liveCommand skips finished panes, since the last pane is normally dead while a live one runs beside it.
export interface PaneState {
    readonly command: string;
    readonly live: boolean;
    readonly exitCode: number | undefined;
    readonly activityAt: number;
    // Foreground command of the last still-alive pane, undefined when every pane is dead; see `foreground` below.
    readonly liveCommand: string | undefined;
}

// One PANE_FORMAT line as tmux wrote it, or undefined when the line isn't one (blank tail, a session that ended
// mid-read).
interface Pane {
    readonly name: string;
    readonly command: string;
    readonly alive: boolean;
    readonly exitCode: number | undefined;
    readonly activityAt: number;
}

const parsePane = (line: string): Pane | undefined => {
    const [name, dead, status, activity, command] = line.split("\t");
    if (name === undefined || name === "" || command === undefined) {
        return undefined;
    }
    const exitCode = Number.parseInt(status ?? "", 10);
    const activitySeconds = Number(activity);
    return {
        name,
        command,
        // Unparseable `pane_dead` reads as alive, the same safe direction the sweep takes.
        alive: dead !== "1",
        exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
        activityAt: Number.isFinite(activitySeconds) && activitySeconds > 0 ? activitySeconds * 1000 : 0,
    };
};

export const paneStates = (stdout: string): Map<string, PaneState> => {
    const states = new Map<string, PaneState>();
    for (const line of stdout.split("\n")) {
        const pane = parsePane(line);
        if (pane === undefined) {
            continue;
        }
        const prior = states.get(pane.name);
        states.set(pane.name, {
            command: pane.command,
            live: pane.alive || prior?.live === true,
            exitCode: pane.exitCode,
            activityAt: pane.activityAt,
            liveCommand: pane.alive ? pane.command : prior?.liveCommand,
        });
    }
    return states;
};

// What is running in a session, in one word, or undefined at an idle prompt; not a boolean, since "pnpm build" is
// answerable and a flag isn't. Read off pane_current_command, the field the kill confirm and the sampler both watch.
export const foreground = (liveCommand: string | undefined): string | undefined =>
    liveCommand === undefined || liveCommand === SHELL ? undefined : liveCommand;
