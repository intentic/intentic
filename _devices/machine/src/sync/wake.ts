import { type FSWatcher, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "@intentic/base/errors";
import { baseDir } from "../config.js";

// WAKING THE WATCHER AT ONCE (2026-10-21). The resident watcher (mirror.ts) re-reads the pairings every pass and sleeps
// POLL_MS between passes, so a pairing `setup` had just recorded waited up to a whole poll before anything prepared its
// session: seconds on every new sandbox's first copy, which `setup` itself sat out (`syncSessionAppears`). A one-shot
// command now touches this file after it writes a pairing, and the watcher's sleep ends when the file changes. The
// watcher never touches it, so its own writes to sync.json (ports, holds) never wake it; a missed or unwatchable change
// costs what it always did, one poll.
const wakePath = join(baseDir, "mirror.wake");
const WAKE_FILE = "mirror.wake";

// Tells a running watcher to take its next pass now. Best effort: a failed write leaves it to its own poll, and says so.
export const wakeWatcher = async (log?: (line: string) => void): Promise<void> => {
    try {
        await writeFile(wakePath, `${Date.now()}\n`);
    } catch (error) {
        log?.(`the watcher was not woken (${errorMessage(error)}); it picks the change up at its next pass`);
    }
};

// Sleeps `ms`, ending early when `wakeWatcher` is called from another process. Rejects as `sleep` does when `signal`
// aborts, so an abandoned watcher stops here as it always has.
export const sleepUnlessWoken = async (ms: number, signal: AbortSignal): Promise<void> => {
    const woken = new AbortController();
    let watcher: FSWatcher | undefined;
    try {
        watcher = watch(baseDir, { persistent: false }, (_event, file) => {
            if (file === WAKE_FILE) {
                woken.abort();
            }
        });
        // A watch that fails later (the folder removed) is no reason to stop sleeping.
        watcher.on("error", () => watcher?.close());
    } catch {
        // allow(silent-catch): a folder that cannot be watched sleeps the whole poll, as every pass did before.
        watcher = undefined;
    }
    try {
        await sleep(ms, undefined, { signal: AbortSignal.any([signal, woken.signal]) });
    } catch (error) {
        if (signal.aborted || !woken.signal.aborted) {
            throw error;
        }
    } finally {
        watcher?.close();
    }
};
