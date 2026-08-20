import { oc } from "@orpc/contract";
import { LogReadQuerySchema, LogReadSchema, LogsListSchema } from "../schemas.js";

// Daemon-owned debug logs (historyRoot/logs): terminal pipe-pane captures, intentic CLI run logs, daemon.log.
// Read-only by design, the files are written by the daemon/tmux only, so the record stays trustworthy.
export const logsContract = {
    list: oc.route({ method: "GET", path: "/logs" }).output(LogsListSchema),
    read: oc.route({ method: "GET", path: "/logs/file" }).input(LogReadQuerySchema).output(LogReadSchema),
};
