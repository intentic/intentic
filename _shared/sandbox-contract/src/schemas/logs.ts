// logs: daemon-owned debug logs (historyRoot/logs)
import { z } from "zod";
// Terminal pipe-pane captures (terminals/), CLI run logs (intentic-runs/), and the daemon's own pino file (daemon.log);
// written by the daemon/tmux only, so the agent can't rewrite them.

export const LogFileEntrySchema = z.object({
    // Relative to the logs root, e.g. "terminals/web-1-%0.log".
    name: z.string().describe("Its name, which is what the read route takes."),
    sizeBytes: z.number().describe("Size in bytes."),
    modifiedAt: z.number().describe("When it last changed, in milliseconds."),
});
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export const LogsListSchema = z.object({
    files: z.array(LogFileEntrySchema).describe("Every log the sandbox keeps: captured terminal output, command runs, and its own log."),
});
export const LogReadQuerySchema = z.object({
    name: z.string().min(1).describe("Which log. It travels in the query rather than the address, because log names contain slashes."),
    bytes: z.coerce
        .number()
        .min(1)
        .max(1_048_576)
        .default(65_536)
        .describe("How much of the end to read. The newest bytes win when the file is larger."),
});
export const LogReadSchema = z.object({
    name: z.string().describe("Which log this is from."),
    sizeBytes: z.number().describe("How large the whole file is."),
    text: z.string().describe("The end of it, as text."),
    truncated: z.boolean().describe("There is more before what you got."),
});
export type LogRead = z.infer<typeof LogReadSchema>;
// What the browser saw when nothing else could capture it: caught errors, self-heal wipes, spans over budget — not
// analytics, not a general log pipe. Capped at the schema so one looping component can't fill the volume; appended to
// logs/client.jsonl under the same prune sweep.
export const ClientDiagnosticSchema = z.object({
    // Distinct from the daemon's own stamp: a batch can arrive seconds late, and a reader correlating a stutter to a
    // daemon span needs the actual moment.
    seenAt: z.number().describe("When the browser saw it, in milliseconds."),
    level: z.enum(["warn", "error"]).describe("How bad it was."),
    // Dotted namespace a reader filters on, e.g. `vue.render`, `self-heal.wipe`, `perf.slow`.
    event: z.string().min(1).max(100).describe("What kind of thing it was, as a stable name."),
    message: z.string().max(2_000).describe("What it said."),
    route: z.string().max(300).optional().describe("Which page they were on."),
    // The join key: without it, matching a stutter to a slow daemon call is eyeballing timestamps.
    requestId: z.string().max(100).optional().describe("Which daemon call it belonged to, when it belonged to one."),
    // Flags a report from a tab that has not reloaded in a while.
    build: z.string().max(100).optional().describe("Which build of the app was running."),
    // Bounded, primitive values only (stack, op name, duration); flat, so a line stays greppable.
    fields: z
        .record(z.string().max(60), z.union([z.string().max(4_000), z.number(), z.boolean()]))
        .optional()
        .describe("Whatever else was worth keeping."),
});
export type ClientDiagnostic = z.infer<typeof ClientDiagnosticSchema>;
// Capped batch: the client already coalesces and drops its own side, and an unbounded array here is a way to fill a
// disk with one request.
export const ClientDiagnosticsReportSchema = z.object({
    events: z.array(ClientDiagnosticSchema).min(1).max(50).describe("What the browser has to report, oldest first."),
});
export type ClientDiagnosticsReport = z.infer<typeof ClientDiagnosticsReportSchema>;
export const ClientDiagnosticsAcceptedSchema = z.object({
    recorded: z.number().describe("How many were written down."),
});
// A tab's self-report, keyed by its /events connection's clientId; full replace, not a merge — absent means cleared.
export const PresenceReportSchema = z.object({
    clientId: z.string().describe("This connection's own id, the same one it gave the event stream."),
    idle: z.boolean().describe("Whether the person has stopped doing anything."),
    view: z.string().optional().describe("Which view they are on."),
    sessionId: z.string().optional().describe("Which conversation they have open."),
    path: z
        .string()
        .optional()
        .describe(
            "Which file they are looking at. Sent whole rather than merged: leaving a field out clears it, so a tab that closes a file drops the path in the same report.",
        ),
});
export type PresenceReport = z.infer<typeof PresenceReportSchema>;
