import { mkdirSync, watch } from "node:fs";

/* THE SHELL SAYING "I AM AT A PROMPT AGAIN", which is the one thing tmux will never say.
 *
 * A pane dying is an event. A command STARTING and FINISHING inside a live shell is not: tmux notifies nobody,
 * `pane_current_command` simply reads differently the next time somebody asks. So the panel's busy dot was
 * always a poll's worth of stale, and the only lever was the length of the poll, one look every two seconds
 * against a command that ends in a millisecond.
 *
 * The shell knows exactly, though, and it is OUR shell (the image's .zshrc). Its preexec/precmd hooks truncate
 * one file in a tmpfs, two syscalls and no fork, and this watcher turns that into the same `terminals` frame a
 * spawn or a kill publishes. The dot lights when the command starts and goes out when the prompt comes back,
 * with no clock in between.
 *
 * The SAMPLER STAYS (system/runtime-watch.ts), because this covers exactly one case, however common: a person
 * typing into a zsh in a tab. An agent's window-per-command sessions, a dev server that dies on its own, a
 * pane killed from outside, a shell that is not ours, all still only change when something looks. This makes
 * the common case instant; it does not make the sandbox event-driven.
 *
 * WHY A FILE. It is the only channel every shell in the container already has, needs no token, no port and no
 * process: `: >| file` is a zsh builtin. The hook is deliberately blind to WHICH session it ran in, the frame
 * says "the terminals moved", and the browser re-reads the list it would have re-read anyway. */

// Watched as a DIRECTORY rather than as a file: an inotify watch follows the inode, so anything that replaced
// the file (a cleaner, a `rm`) would silently stop the feed, while the directory outlives every write into it.
// Its own directory, not /run/intentic, so the boot-time agent token next door cannot be mistaken for a prompt.
export const PROMPT_SIGNAL_DIR = "/run/intentic/shell";

/** Call `onSignal` every time a shell reaches a prompt (and every time one leaves it). Returns the unsubscribe.
 *
 *  Nothing here fails loudly: no /run (a workstation running the tests, a stripped image) means no signals and
 *  the sampler carries on alone, which is the behaviour this replaced. The directory is created here rather
 *  than at boot so that it exists for as long as anything is listening, and a shell whose write lands before
 *  the first browser connects loses nothing: a browser connecting re-asks every runtime-bound key anyway. */
export const watchPromptSignals = (onSignal: () => void, dir: string = PROMPT_SIGNAL_DIR): (() => void) => {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const watcher = watch(dir, () => onSignal());
        // A watch that dies (the tmpfs went away, inotify ran out of watches) takes its own listener down
        // rather than the daemon: an unhandled "error" on an EventEmitter is a process-level throw.
        watcher.on("error", () => watcher.close());
        watcher.unref();
        return () => watcher.close();
    } catch {
        return () => {};
    }
};
