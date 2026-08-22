import { oc } from "@orpc/contract";
import { ClientDiagnosticsAcceptedSchema, ClientDiagnosticsReportSchema, LogReadQuerySchema, LogReadSchema, LogsListSchema } from "../schemas.js";

// Daemon-owned debug logs (historyRoot/logs): terminal pipe-pane captures, intentic CLI run logs, daemon.log.
// Reads are read-only by design, the files are written by the daemon/tmux only, so the record stays
// trustworthy. `report` is the one write, and the exception that proves the rule: the browser is the only
// witness to its own crashes, and a record it cannot reach is a record that has nothing to say about them.
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
    /* What the browser saw. The counterpart to every other route here: those serve what the daemon wrote down,
     * this accepts what only the browser could have known.
     *
     * A WRITE from the client, which every other log route deliberately is not, and the trust argument is the
     * inverse of theirs: the reads are trustworthy because only the daemon writes them, and this is trustworthy
     * only about ITSELF. So it lands in its own file, never daemon.log, and its lines say plainly that a browser
     * said them. It floors at viewer rather than the maintainer the logs prefix takes, because a viewer whose
     * page just white-screened is exactly who needs to be able to report it, and cannot raise their own role to
     * do it. */
    report: oc
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
