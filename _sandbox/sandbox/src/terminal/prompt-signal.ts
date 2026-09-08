import { mkdirSync, watch } from "node:fs";

// A shell reaching a prompt again is the one transition tmux never announces; our .zshrc's preexec/precmd hooks touch
// one tmpfs file, and this watcher turns that into the same `terminals` frame a spawn or kill publishes. The sampler
// still covers everything else (agent sessions, dev servers, killed panes) that only changes when polled.

// Watched as a directory: inotify follows an inode, so a replaced file would silently stop the feed.
export const PROMPT_SIGNAL_DIR = "/run/intentic/shell";

/**
 * Calls `onSignal` whenever a shell reaches or leaves a prompt; returns the unsubscribe. Fails silently: no /run means
 * no signals, and the sampler carries on alone.
 */
export const watchPromptSignals = (onSignal: () => void, dir: string = PROMPT_SIGNAL_DIR): (() => void) => {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const watcher = watch(dir, () => onSignal());
        // Closed on its own error, since an unhandled 'error' event on an EventEmitter crashes the process.
        watcher.on("error", () => watcher.close());
        watcher.unref();
        return () => watcher.close();
    } catch {
        return () => {};
    }
};
