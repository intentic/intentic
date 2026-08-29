// logs: daemon-owned debug logs (historyRoot/logs)
import { z } from "zod";
// Terminal pipe-pane captures (terminals/), intentic CLI run logs (intentic-runs/), and the daemon's own pino
// file (daemon.log), written by the daemon/tmux only, under historyRoot so the agent can't rewrite them.

export const LogFileEntrySchema = z.object({
    // Path relative to the logs root, e.g. "terminals/web-1-%0.log" or "daemon.log".
    name: z.string().describe("Its name, which is what the read route takes."),
    sizeBytes: z.number().describe("Size in bytes."),
    // Epoch ms mtime.
    modifiedAt: z.number().describe("When it last changed, in milliseconds."),
});
export type LogFileEntry = z.infer<typeof LogFileEntrySchema>;
export const LogsListSchema = z.object({
    files: z.array(LogFileEntrySchema).describe("Every log the sandbox keeps: captured terminal output, command runs, and its own log."),
});
// `name` rides the query (log names contain slashes, which don't fit a path segment); `bytes` is the tail
// size, the newest bytes win when the file is larger.
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
    // The tail text; truncated when the file holds more than the requested bytes.
    text: z.string().describe("The end of it, as text."),
    truncated: z.boolean().describe("There is more before what you got."),
});
export type LogRead = z.infer<typeof LogReadSchema>;
/* ---- client diagnostics: what the BROWSER saw, landed where the daemon's own records live ----
 *
 * The one gap no daemon-side record could ever close. Everything the editor measured or caught ended at
 * `console.warn`: the perf ring buffer dies on reload, a render error reaches Vue's handler and stops there, and
 * the startup self-heal CLEARS this origin's storage and reloads, destroying the evidence for the one class of
 * bug that reproduces least often. So when a user hit a bug in their own browser the durable record was
 * nothing, and the only way to investigate was to re-drive a browser and hope. Measured over 728 sessions that
 * is 1,545 screenshots against 65 console reads, and a quarter of all prompts arriving with a picture attached
 * because there was no other channel.
 *
 * Deliberately NARROW. This is not analytics (PostHog owns product events) and not a log pipe: it carries the
 * things a person cannot describe and a screenshot cannot show, which are caught errors, self-heal wipes, and
 * spans that blew their frame budget. Everything is capped at the schema so one looping component cannot fill
 * the /history volume, and the daemon appends to logs/client.jsonl under the same prune sweep as the rest. */
export const ClientDiagnosticSchema = z.object({
    // When the BROWSER saw it. Distinct from the `time` the daemon stamps on the record, because a batch can
    // arrive seconds late and a reader correlating a stutter to a daemon span needs the moment it happened.
    seenAt: z.number().describe("When the browser saw it, in milliseconds."),
    level: z.enum(["warn", "error"]).describe("How bad it was."),
    // A stable name, not free text: this is what a reader filters on. e.g. `vue.render`, `window.error`,
    // `unhandled.rejection`, `self-heal.wipe`, `perf.slow`.
    event: z.string().min(1).max(100).describe("What kind of thing it was, as a stable name."),
    message: z.string().max(2_000).describe("What it said."),
    // The app route the user was on, which is the single most useful field for reproducing anything.
    route: z.string().max(300).optional().describe("Which page they were on."),
    /* The id this browser put on the daemon call it was making, when there was one. The join key: without it
     * "the UI stuttered at 15:22" and "slow http.request at 15:22" can only be matched by eye. */
    requestId: z.string().max(100).optional().describe("Which daemon call it belonged to, when it belonged to one."),
    // Which build this browser was running, so a report from a tab nobody has reloaded in a week says so.
    build: z.string().max(100).optional().describe("Which build of the app was running."),
    // Bounded and primitive: a stack, an op name, a duration. Kept flat so a line stays greppable.
    fields: z
        .record(z.string().max(60), z.union([z.string().max(4_000), z.number(), z.boolean()]))
        .optional()
        .describe("Whatever else was worth keeping."),
});
export type ClientDiagnostic = z.infer<typeof ClientDiagnosticSchema>;
// A batch. Capped: the client coalesces and drops on its own side too, and a route that accepts an unbounded
// array is a way to fill a disk with one request.
export const ClientDiagnosticsReportSchema = z.object({
    events: z.array(ClientDiagnosticSchema).min(1).max(50).describe("What the browser has to report, oldest first."),
});
export type ClientDiagnosticsReport = z.infer<typeof ClientDiagnosticsReportSchema>;
export const ClientDiagnosticsAcceptedSchema = z.object({
    recorded: z.number().describe("How many were written down."),
});
// A tab's self-report of what it is looking at, keyed by its /events connection's clientId. Full replace,
// not a merge, an absent field means "cleared", so a tab leaving a file drops the path with the same report.
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
