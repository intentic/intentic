import { z } from "zod";

// THE DIAGNOSTICS QUERIES: read-only questions over what a sandbox's daemon already recorded (its log, the editor's
// reports, slow spans and rollups, the turn ledger, the resource series, its boots, one conversation's timeline). One
// set of arguments serves every door that asks them: the `diagnostics` tools a turn mounts, the `diagnostics` command on
// the agent's PATH (POST /diagnostics), and a linked sandbox reading this one's records (POST /link/records/diagnostics).
// Each answers with text written to be read, never the raw lines, and each takes a window.

// Two weeks and a day: the perf rollups keep two weeks; every other record reaches less far, and says so.
export const DIAGNOSTICS_MAX_MINUTES = 15 * 24 * 60;
// Bounds one answer's rows; a caller that hits the cap is told and narrows.
export const DIAGNOSTICS_MAX_LINES = 200;

const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export const DiagnosticsLevelSchema = z.enum(levels);

const minutes = () => z.number().int().min(1).max(DIAGNOSTICS_MAX_MINUTES).optional();
const limit = () => z.number().int().min(1).max(DIAGNOSTICS_MAX_LINES).optional();
const instant = () => z.iso.datetime({ offset: true });

/** `errors`: the daemon's log or the editor's reports, newest first. */
export const DiagnosticsErrorsArgs = {
    source: z
        .enum(["daemon", "browser"])
        .optional()
        .describe("Whose account of it: the sandbox's own log, or what the editor sent about itself. Defaults to the daemon."),
    sinceMinutes: minutes().describe("How far back to look. Leave it out for everything the file still holds."),
    from: instant()
        .optional()
        .describe("Start of an absolute window (ISO time, e.g. `2026-11-07T23:40:00Z`), instead of `sinceMinutes`: for reading around a moment you already know."),
    until: instant()
        .optional()
        .describe("End of the window (ISO time): lines after it are left out. With `from`, reads exactly the lines between the two."),
    level: DiagnosticsLevelSchema.optional().describe("Lowest level to include, and it includes worse ones. Defaults to `warn`, which is what went wrong."),
    contains: z
        .string()
        .max(200)
        .optional()
        .describe("Case-insensitive substring, matched anywhere in the line: a conversation id, an error code, a route, a message."),
    group: z
        .boolean()
        .optional()
        .describe("true: one row per kind of message, with its count and first and last time. false: every line. Left out, lines are grouped once there are more than `limit`."),
    stacks: z.boolean().optional().describe("Include each exception's stack. Off by default: stacks dwarf the line they belong to."),
    limit: limit(),
};

/** `slow`: operations over their budget, or every span's rollups. */
export const DiagnosticsSlowArgs = {
    source: z
        .enum(["slow", "rollups"])
        .optional()
        .describe(
            "`slow` (the default): the spans over budget, one by one, from perf.jsonl (about a week). `rollups`: the distribution of every span from perf-rollups.jsonl (two weeks), with no single span or load to show.",
        ),
    sinceMinutes: minutes(),
    op: z
        .string()
        .max(100)
        .optional()
        .describe("One operation by its exact name (`git.run` is not `git.run.wait`), or every one under a prefix ending in `.` or `*` (`git.`, `devices.*`)."),
    groupBy: z
        .enum(["op", "op+path", "none"])
        .optional()
        .describe(
            "`op` one row per operation; `op+path` splits each by its subject (the route of a request, the git subcommand, the hook's tool); `none` every span. Left out, spans are grouped by op once there are more than `limit`. Rollups have no single spans, so `none` reads as `op+path` there.",
        ),
    limit: limit(),
};

/** `turns`: how recent agent turns ended, from the spend ledger. */
export const DiagnosticsTurnsArgs = {
    sinceMinutes: minutes(),
    conversationId: z.string().max(200).optional().describe("Narrow to one conversation."),
    only: z
        .enum(["failed", "unproven", "silent", "interrupted"])
        .optional()
        .describe(
            'Narrow to one kind of ending: "failed" is turns that failed or were cancelled, "unproven" is turns that ' +
                "changed code and finished with nothing having checked it (including ones whose last check broke), " +
                '"silent" is turns that ran but called no tool and changed no file, "interrupted" is turns a restart or ' +
                "a spent allowance cut off. Leave it out for every turn.",
        ),
    limit: limit(),
};

/** `resources`: one field of the resource series over time. */
export const DiagnosticsResourcesArgs = {
    field: z.string().min(1).max(200).describe("Dotted path into one sample, e.g. `system.cgroup.event_oom_kill`."),
    sinceMinutes: minutes(),
    limit: limit(),
};

/** `restarts`: the daemon's boots and why each run before ended. */
export const DiagnosticsRestartsArgs = { sinceMinutes: minutes(), limit: limit() };

/** `timeline`: everything recorded about one conversation, oldest first. */
export const DiagnosticsTimelineArgs = {
    conversationId: z.string().min(1).max(200).describe("The conversation's id, e.g. `wise-fern-usz1`."),
    sinceMinutes: minutes(),
    level: DiagnosticsLevelSchema.optional().describe("Lowest daemon.log level to include. Defaults to `info`, so the turn's own lifecycle lines are in."),
    limit: z.number().int().min(1).max(DIAGNOSTICS_MAX_LINES).optional().describe("The newest this many events. Defaults to 100."),
};

// One query, named by `query`, with that query's own arguments.
export const DiagnosticsQuerySchema = z.discriminatedUnion("query", [
    z.object({ query: z.literal("errors"), ...DiagnosticsErrorsArgs }),
    z.object({ query: z.literal("slow"), ...DiagnosticsSlowArgs }),
    z.object({ query: z.literal("turns"), ...DiagnosticsTurnsArgs }),
    z.object({ query: z.literal("resources"), ...DiagnosticsResourcesArgs }),
    z.object({ query: z.literal("restarts"), ...DiagnosticsRestartsArgs }),
    z.object({ query: z.literal("timeline"), ...DiagnosticsTimelineArgs }),
]);
export type DiagnosticsQuery = z.infer<typeof DiagnosticsQuerySchema>;
export type DiagnosticsQueryName = DiagnosticsQuery["query"];
export const DIAGNOSTICS_QUERY_NAMES = ["errors", "slow", "turns", "resources", "restarts", "timeline"] as const satisfies readonly DiagnosticsQueryName[];

// POST /diagnostics: one query of this sandbox's records, or, with `on`, of the linked sandbox that card names, read
// through the link (its owner must share records on it).
export const DiagnosticsAskSchema = z.intersection(
    DiagnosticsQuerySchema,
    z.object({
        on: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe("A link card's id: ask the linked sandbox instead of this one. `agents links` names the links this turn may use."),
    }),
);
export type DiagnosticsAsk = z.infer<typeof DiagnosticsAskSchema>;

export const DiagnosticsAnswerSchema = z.object({
    text: z.string().describe("The answer, as the diagnostics tools word it: what it searched, how far back the record reaches, then the rows."),
    sandbox: z.string().optional().describe("Whose records these are, when they are a linked sandbox's."),
});
export type DiagnosticsAnswer = z.infer<typeof DiagnosticsAnswerSchema>;

/* A CONVERSATION'S DEBUG BUNDLE: one file holding what a person or an agent elsewhere needs to look into what happened
 * to one conversation, without access to the sandbox it ran in. GET /fleet/{handle}/bundle (and the link's records door)
 * answers it; `agents bundle` writes it, and the editor downloads it. Every part is what the sandbox already shows its
 * own agents: secrets ride as their `{{secret:name}}` references, as they are stored. */

export const CONVERSATION_BUNDLE_KIND = "intentic.conversation-bundle";

export const ConversationBundleSchema = z.object({
    kind: z.literal(CONVERSATION_BUNDLE_KIND),
    version: z.literal(1),
    exportedAt: z.string().describe("When it was put together, ISO time."),
    sandbox: z.object({
        name: z.string().describe("What the sandbox calls itself."),
        version: z.string().optional().describe("The daemon's version: 0.0.0 is an unreleased build."),
    }),
    conversation: z.string().describe("The conversation's id."),
    // What `agents show` answers, as JSON: what it was asked, where it got to, its branch, how it ended.
    show: z.unknown(),
    // The record as stored, newest last, bounded: `total` says how many rows it has.
    transcript: z.unknown(),
    // The diagnostics answers about it, each as the `diagnostics` command words it.
    timeline: z.string(),
    turns: z.string(),
    errors: z.string(),
    restarts: z.string(),
    browser: z.string().describe("What the editor reported about itself while the conversation ran."),
});
export type ConversationBundle = z.infer<typeof ConversationBundleSchema>;
