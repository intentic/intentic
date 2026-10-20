import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";

// Calls `onChange` whenever `path` may have changed, so a reader of a growing log answers when a line lands rather than
// on its next poll (2026-10-20). It watches the file's folder, not the file: a log that does not exist yet (a program
// that has printed nothing, a run that has not opened it) is seen the moment it appears, and a file replaced under the
// same name is still followed. Answers undefined when this folder cannot be watched; the caller's fallback timer
// carries the wait then. The events are only a hint to re-read, never a count of writes: platforms merge and drop them.
export const onFileChange = (path: string, onChange: () => void): (() => void) | undefined => {
    const name = basename(path);
    let watcher: FSWatcher;
    try {
        watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
            // Some platforms do not name the file; a re-read the change was not for costs one read.
            if (changed === null || changed === name) {
                onChange();
            }
        });
    } catch {
        // allow(silent-catch): an unwatchable folder (missing, a network drive) is the fallback timer's to cover; the caller has one.
        return undefined;
    }
    // A watch that fails later (the folder removed) stops; the fallback timer still re-reads.
    watcher.on("error", () => watcher.close());
    return () => watcher.close();
};
