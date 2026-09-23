import { procedure } from "../protocol/route-meta.js";
import {
    ClientDiagnosticsAcceptedSchema,
    ClientDiagnosticsReportSchema,
    LogReadQuerySchema,
    LogReadSchema,
    LogsListSchema,
} from "../schemas/logs.js";

// Daemon logs are the operator's diagnostic, not a stakeholder's feed, and no token's.
const logRoute = procedure.meta({ floor: "maintainer", control: "never" });

// Daemon-owned debug logs (historyRoot/logs): terminal captures, CLI run logs, daemon.log; read-only, since only the
// daemon/tmux write them. `report` is the one write, since the browser is the only witness to its own crashes.
export const logsContract = {
    list: logRoute
        .route({
            method: "GET",
            path: "/logs",
            summary: "Logs the sandbox keeps",
            description:
                "Every log file the daemon owns: captured terminal output, command runs, and the daemon's own log. Read-only, because only the sandbox writes them.",
        })
        .output(LogsListSchema),
    read: logRoute
        .route({
            method: "GET",
            path: "/logs/file",
            summary: "Read part of a log",
            description: "A window of one log file's text. A window rather than the whole thing, because a busy log outgrows any single answer.",
        })
        .input(LogReadQuerySchema)
        .output(LogReadSchema),
    // The one write route; lands in its own file, never daemon.log, floored at viewer role for a crashed page.
    report: procedure
        .meta({ floor: "viewer", control: "never" })
        .route({
            method: "POST",
            path: "/logs/client",
            summary: "Report what the browser saw",
            description:
                "Errors the app caught, stalls it measured, and recoveries it performed, written to a log of their own. The browser is the only witness to these, so without it a bug someone hit in their own browser leaves no record at all.",
        })
        .input(ClientDiagnosticsReportSchema)
        .output(ClientDiagnosticsAcceptedSchema),
};
