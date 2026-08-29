/* WHAT THE DAEMON READS OFF TMUX'S PANES, in one place, because two callers ask tmux the same question and
 * must never answer it differently: the terminals list the browser renders (system/system.routes.ts), and the
 * sampler that decides when to tell the browser to re-ask (system/runtime-watch.ts).
 *
 * They DID differ, and the cost was the panel's busy dot outliving the command by up to ten seconds. The list
 * has always reported the foreground command; the sampler's fingerprint left it out, so a build ending, the
 * pane back at its prompt, changed nothing the sampler was looking at, and the dot only went out when some
 * unrelated field (the coarse activity bucket) happened to move. Sharing the format string and the fold is
 * what makes that class of drift impossible rather than merely fixed. */

// The one `tmux list-panes -F` line both readers parse. One line per PANE, so a multi-window session (every
// agent-*/job-* one: bin/tmux-run opens a window per command and keeps the finished ones under remain-on-exit)
// reports many. `session_activity` is session-wide, so every line of a session repeats it, and
// `pane_dead_status` is empty while the pane lives.
export const PANE_FORMAT = "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{session_activity}\t#{pane_current_command}";

// The image's default-command shell (Dockerfile). `pane_current_command` reads this at an idle prompt, which is
// how `foreground` below tells a busy pane from a waiting one, how the managed-process sweep sees a oneShot job
// finish, and how the terminals list sees a background process crash.
export const SHELL = "zsh";

// Fold `tmux list-panes -a` output into one row per SESSION: the last pane's foreground command and exit
// status, the session's last-activity stamp, plus whether any pane in it is still alive. Liveness has to be
// per-session because agent-*/job-* sessions carry a window per command and bin/tmux-run keeps finished ones
// (remain-on-exit) so their output stays readable, the last command of a turn always leaves a dead window
// behind, and a session with only dead windows is a session nothing is running in. Unparseable `pane_dead`
// reads as alive: the flag gates a destructive sweep, so the safe direction is "keep".
//
// `exitCode` follows `command`, the LAST pane wins, which for a window-per-command session is precisely the
// last command's status (empty, hence undefined, while that pane still runs). `activityAt` is session-wide, so
// every line of a session carries the same value; 0 stands for "tmux didn't say", and both consumers (the work
// popover's "how long since this said anything", the retention sweep's clock) read that as unknown rather than
// as 1970.
//
// `liveCommand` is the same field read for a different question, and the distinction is the whole of why it is
// separate. `command` is the LAST pane's, dead or alive, a finished command's ghost, which is exactly what
// makes it right for an exit status and wrong for "is anything happening in here". A window-per-command session
// (agent-*, job-*) keeps its finished panes on purpose (remain-on-exit, so their output stays readable), so its
// last pane is normally a corpse while a live one runs beside it. This one skips the corpses.
export interface PaneState {
    readonly command: string;
    readonly live: boolean;
    readonly exitCode: number | undefined;
    readonly activityAt: number;
    // The foreground command of the last pane that is still ALIVE, undefined when every pane in the session is
    // dead. What "something is running in here" is read off (see `foreground` below).
    readonly liveCommand: string | undefined;
}

// One PANE_FORMAT line as tmux wrote it, or nothing when the line is not one (the blank tail of the output, a
// session that ended between the list and the read).
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

/* WHAT IS RUNNING IN A SESSION RIGHT NOW, in one word, or nothing at all, when it is sitting at its prompt.
 *
 * This is the difference the terminals list could not previously state, and the gap was a data loss the user
 * paid for. Every `web-*` shell reports `running: true` whether it holds a two-minute build or a bare prompt
 * (see the terminals handler), so the panel's × had nothing to tell those two apart with, and it kills a tmux
 * session for good. One mis-aimed click on the pill next to the one you meant, and the build, the test run, or
 * the editor holding unsaved buffers went with it, silently and with no way back.
 *
 * tmux was answering this all along: `pane_current_command` is the shell itself at an idle prompt and the
 * foreground process otherwise. The list already asked for it and threw it away for every kind but `process`.
 * The browser confirms on this field and labels the pill with it (web/pages/TerminalPanel.vue), and the sampler
 * watches the same reading, so the pill lights and goes out with the command rather than with a clock.
 *
 * Deliberately not a boolean. "Kill the running terminal?" is a question the user cannot answer; "pnpm build"
 * is one they can, and it costs nothing over a flag, because the word is what tmux hands us. An editor or a
 * pager counts as busy on the same terms as a build: it is a foreground process with state in it, and it is
 * the honest reading of "something is going on in here". */
export const foreground = (liveCommand: string | undefined): string | undefined =>
    liveCommand === undefined || liveCommand === SHELL ? undefined : liveCommand;
