import { closeSync, openSync, writeSync } from "node:fs";
import type { Sink } from "./output.js";

// Mirrors the command's ndjson event stream to a file the daemon tails for live progress. Append-only (the daemon
// truncates before launch); sync writes so the exit hook can stamp `{kind:"exit"}` even on a thrown error.
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
