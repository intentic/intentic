import { oc } from "@orpc/contract";
import { LogReadQuerySchema, LogReadSchema, LogsListSchema } from "../schemas.js";

// Daemon-owned debug logs (historyRoot/logs): terminal pipe-pane captures, intentic CLI run logs, daemon.log.
// Read-only by design, the files are written by the daemon/tmux only, so the record stays trustworthy.
export const logsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/logs",
            summary: "Logs the sandbox keeps",
            description:
                "Every log file the daemon owns: captured terminal output, command runs, and the daemon's own log. Read-only, because only the sandbox writes them.",
        })
        .output(LogsListSchema),
    read: oc
        .route({
            method: "GET",
            path: "/logs/file",
            summary: "Read part of a log",
            description: "A window of one log file's text. A window rather than the whole thing, because a busy log outgrows any single answer.",
        })
        .input(LogReadQuerySchema)
        .output(LogReadSchema),
};
