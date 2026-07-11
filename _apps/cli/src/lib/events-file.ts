import { closeSync, openSync, writeSync } from "node:fs";
import type { Sink } from "./output.js";

// The structured-events half of a daemon-driven run: when the daemon sets INTENTIC_EVENTS_FILE, the command
// (resolve/plan/apply/adopt) mirrors its ndjson event stream (node/readiness/iteration/prune/result) to that
// file so the web can tail live structured progress that survives a page refresh — independent of the pane's
// human-text rendering. Append-only: the daemon truncates the file and writes the {kind:"start"} marker before
// launching, so a stale prior run is never seen. A process.on("exit") hook stamps the terminal
// {kind:"exit",command,code} — it fires on a thrown command too (stricli still exits non-zero), so a failed run
// is marked, not left hanging. `command` tags whose exit it is: in the apply → adopt chain, apply's exit ends
// the per-resource phase and adopt's (or a failed earlier command's — `&&` means the rest never ran) ends the
// whole job; a single-command run (check's resolve or plan) ends on its own exit. Sync fs like run-log.ts: the
// exit hook is the only place stricli's failure exit code is visible and must write now.
export const createEventsFileSink = (path: string, command: string): Sink => {
    const fd = openSync(path, "a");
    process.on("exit", (code) => {
        try {
            writeSync(fd, `${JSON.stringify({ kind: "exit", command, code })}\n`);
            closeSync(fd);
        } catch {
            // Too late to report anything.
        }
    });
    return {
        write: (chunk) => {
            writeSync(fd, chunk);
        },
    };
};
