import { existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

// inotify is per inode, so a write from a turn's own mount namespace still reaches a daemon watching the same /tmp.

/**
 * Calls `onAppear` once `path` exists (at once if it already does), off its parent directory's watch; returns the stop,
 * or undefined when the directory cannot be watched and the caller's own clock is the only way to notice.
 */
export const whenFileAppears = (path: string, onAppear: () => void): (() => void) | undefined => {
    const name = basename(path);
    let done = false;
    let stop: () => void = () => undefined;
    const appeared = (): void => {
        if (done) {
            return;
        }
        done = true;
        stop();
        onAppear();
    };
    try {
        const watcher = watch(dirname(path), (_event, changed) => {
            if (changed === name && existsSync(path)) {
                appeared();
            }
        });
        // The directory going away (the tmp sweep) ends the watch; the caller's floor notices what follows.
        watcher.on("error", () => watcher.close());
        watcher.unref();
        stop = () => watcher.close();
    } catch {
        return undefined;
    }
    // Checked after the watch is up, so a file landing between the two is caught by one or the other.
    if (existsSync(path)) {
        appeared();
    }
    return () => {
        done = true;
        stop();
    };
};
