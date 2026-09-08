// Inbound bug reports from the owner's own sites and apps, grouped by fingerprint
// (.intentic/records/issues/<fingerprint>.json, one file per group).
import { z } from "zod";
import { entryId } from "./internal.js";

// Three shapes: `IssueReportSchema` (untrusted, from a stranger's POST), `IssueSchema` (the daemon's per-fingerprint
// group with a count and latest sample), and `IssuesConfigSchema`/`IssuePublicConfigSchema` (owner settings vs. what
// the SDK reads back). Imported as types only, so zod never reaches a browser.

// `crash` and `detection` group under one fingerprint with a rising count; `report` never groups, since two people's
// own words are two different things.
export const IssueKindSchema = z.enum(["crash", "report", "detection"]);
export type IssueKind = z.infer<typeof IssueKindSchema>;

// Flat {at, kind, message} rather than a per-source union, so breadcrumbs from any instrumentation render as one
// ordered timeline without the agent knowing which ones fired.
export const IssueBreadcrumbSchema = z.object({
    at: z.number().describe("When, in milliseconds."),
    kind: z.string().max(40).describe("What sort of thing it was: a console line, a request, a click, a route change."),
    message: z.string().max(300).describe("What it said, already truncated by the SDK."),
});
export type IssueBreadcrumb = z.infer<typeof IssueBreadcrumbSchema>;

// Unverified by construction: both fields are typed by the reporter and ride beside the content, never above it. No
// sign-in ceremony can run on a dying page.
export const IssueReporterSchema = z.object({
    email: z.string().max(320).optional().describe("An address they typed, to reach them about it. Unverified."),
    name: z.string().max(200).optional().describe("A name they typed. Unverified, and never identity."),
});
export type IssueReporter = z.infer<typeof IssueReporterSchema>;

// Host-supplied strings (route, version, locale, tenant); bounded in both key count and length, the one open-ended
// field on a public endpoint.
const CONTEXT_KEYS_MAX = 20;
const IssueContextSchema = z
    .record(z.string().max(60), z.string().max(300))
    .refine((context) => Object.keys(context).length <= CONTEXT_KEYS_MAX, { message: `at most ${CONTEXT_KEYS_MAX} context entries` });

// One report as it arrives; only `kind`/`message` are required, since demanding every kind's fields would refuse the
// commonest case (`window.onerror` with little else).
export const IssueReportSchema = z.object({
    kind: IssueKindSchema.describe("A crash the SDK caught, something a person wrote in, or a problem the SDK noticed on its own."),
    message: z.string().min(1).max(1000).describe("The error's own message, or the headline of what a person reported."),
    stack: z.string().max(20_000).optional().describe("The stack, verbatim from the browser."),
    url: z.string().max(2000).optional().describe("Where it happened: the page's address, or a screen name in an app."),
    // No artifact store or sourcemap pipeline needed: absent, the agent just guesses which build it came from.
    release: z.string().max(200).optional().describe("Which build it came from: a commit sha or a tag. With it the agent reads your real source rather than minified frames."),
    userAgent: z.string().max(400).optional().describe("What the browser said it was."),
    description: z.string().max(5000).optional().describe("What the person typed, when a person is the one reporting."),
    reporter: IssueReporterSchema.optional().describe("Who says they are reporting it. Unverified by construction."),
    breadcrumbs: z.array(IssueBreadcrumbSchema).max(40).optional().describe("What happened just before, oldest first."),
    context: IssueContextSchema.optional().describe("Whatever else the app attached: a route, a version, a locale."),
    // Hashed like everything else; never used as a filename directly.
    fingerprint: z.string().max(200).optional().describe("Group by this instead of by the stack, when your app knows better than the stack does."),
});
export type IssueReport = z.infer<typeof IssueReportSchema>;

// POSTed to /intake/<id>/report: the report plus what the gate needs (client id, anti-bot answer) but never stores —
// keeps the stored sample pure evidence, not doorman's paperwork.
export const IssueIngestSchema = z.object({
    report: IssueReportSchema,
    // Per-minute limit key; distinct from the daily budget below.
    clientId: z.string().min(1).max(200).describe("The SDK's own id for this browser. Not a secret: it is what the rate limit counts against."),
    // Only for `report`, and only if a proof-of-work is asked for; a crash has no second to spend on a puzzle.
    powNonce: z.string().max(400).optional(),
    // For a client with no Origin header; an abuse label, not a secret (ships inside a binary) — dedup, rate limit and
    // daily budget are the real ceilings.
    key: z.string().max(200).optional(),
});
export type IssueIngest = z.infer<typeof IssueIngestSchema>;

// `investigating` is set only by the daemon when a turn actually starts (a wake, or the Investigate button); never
// guessed, never settable by a click.
export const IssueStatusSchema = z.enum(["open", "investigating", "resolved", "ignored"]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

// One agent turn for this issue; the conversation id is the link, so nothing about the run itself needs storing beyond
// it.
export const IssueRunSchema = z.object({
    conversationId: z.string().describe("The conversation this run became."),
    at: z.number().describe("When it started, in milliseconds."),
    // Lets a post-fix recurrence read as "it came back", not "already looked at".
    atCount: z.number().describe("How many times it had happened when this run started."),
});
export type IssueRun = z.infer<typeof IssueRunSchema>;

// One group; the id is the fingerprint and the filename, never in the body, so a body cannot disagree with its own
// grouping.
export const IssueSchema = z.object({
    kind: IssueKindSchema,
    // Derived from the report, never typed, so two recurrences of one crash can't end up under two titles.
    title: z.string().min(1).max(300).describe("The one line this is listed under."),
    culprit: z.string().max(300).optional().describe("The frame it came from, when the stack named one."),
    // A workspace can run several intakes (one per site); the inbox is one list across all of them.
    automationId: entryId.describe("Which intake received it."),
    // Absent for a keyed client (mobile app, server) with no Origin header to send.
    origin: z.string().max(400).optional().describe("Which site it came from."),
    firstSeen: z.number().describe("When it first happened, in milliseconds."),
    lastSeen: z.number().describe("When it last happened, in milliseconds."),
    count: z.number().describe("How many times this exact thing has arrived."),
    status: IssueStatusSchema.default("open").describe("Where it stands with you."),
    statusAt: z.number().optional().describe("When the status last changed, in milliseconds."),
    release: z.string().max(200).optional().describe("The build the latest one came from."),
    // Latest, not first: a fix must match what it looks like now, not a build that may no longer exist.
    sample: IssueReportSchema.describe("The most recent one, in full."),
    // Escalation rule lives in this number: fires once when new, again only once count has moved this far past it.
    // Stored, since a restart can't derive it from a count and timestamp.
    firedAt: z.number().optional().describe("What the count stood at the last time this woke an agent."),
    runs: z.array(IssueRunSchema).max(20).optional().describe("The turns started for it."),
});
export type Issue = z.infer<typeof IssueSchema>;

// The list row: the stored group plus its filename id (the fingerprint).
export const IssueSummarySchema = IssueSchema.extend({ id: entryId.describe("The issue's id, which is its fingerprint.") });
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

// `invalid`: nothing but the daemon writes these files, so one that fails to parse is a bug in this daemon or a
// half-written volume, worth surfacing not skipping.
export const IssuesListSchema = z.object({
    issues: z.array(IssueSummarySchema).describe("The inbox, most recently seen first."),
    invalid: z.array(z.string()).describe("Files in the issues directory that could not be read at all."),
});
export type IssuesList = z.infer<typeof IssuesListSchema>;

export const IssueIdParamSchema = z.object({ id: entryId.describe("Which issue.") });
// `investigating` is not offered here: the daemon sets it when a turn actually starts, so a click can't fake the one
// status that means something.
export const IssueStatusInputSchema = z.object({
    id: entryId.describe("Which issue."),
    status: z.enum(["open", "resolved", "ignored"]).describe("Where it now stands with you."),
});
export type IssueStatusInput = z.infer<typeof IssueStatusInputSchema>;

// Present only on `issues` listener automations. `allowedOrigins` is not here: it lives on the trigger, since the
// ingest route reads it as the admission gate, not a rendering choice.
export const IssuesConfigSchema = z.object({
    // Ingest key lives in the secrets store (`AutomationSummary.ingestKey`), not here — an abuse label the origin
    // allowlist and ceilings actually bound, not a secret.
    // Off by default: a leaked key in a public bundle is the commonest abuse, and the allowlist is what limits it.
    keyFromBrowsers: z.boolean().optional().describe("Let a browser report with the key alone, rather than only from a site you listed. Off unless you need it."),
    // Per UTC day, counted in reports that reach the store; absent means ISSUES_DAILY_MAX_DEFAULT, never uncapped.
    dailyReportMax: z.number().int().positive().optional().describe("How many reports a day this intake accepts at all."),
    // Wakes an agent on new, then again once count has grown this much since the last wake; absent means
    // ISSUES_ESCALATE_AFTER_DEFAULT. Without a cap, a crash loop is a turn per browser.
    escalateAfter: z.number().int().positive().optional().describe("How many more times a known crash must happen before it wakes an agent again."),
    // Written reports only, never a crash; absent means off, leaving the allowlist and ceilings as the boundary.
    antiBot: z.enum(["pow"]).optional().describe("Make a person's browser solve a small puzzle before it accepts a written report."),
    // The report dialog's chrome; public by construction.
    title: z.string().max(80).optional().describe("The dialog's heading."),
    prompt: z.string().max(300).optional().describe("The line above the box they type in."),
    thanks: z.string().max(300).optional().describe("What it says once they have sent it."),
    askEmail: z.boolean().optional().describe("Ask for an address to reply to. Optional for them either way."),
    // Hex colour; the SDK derives a hover and focus ring from its channels, not just paints it.
    accent: z
        .string()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour, e.g. #e47100")
        .optional(),
    // Absent means on: a site that embedded this meant to report crashes.
    captureCrashes: z.boolean().optional().describe("Catch uncaught errors automatically, as well as what people write in."),
});
export type IssuesConfig = z.infer<typeof IssuesConfigSchema>;

// Fully resolved daemon-side; every field is named here so a secret added to `IssuesConfig` later stays invisible until
// deliberately listed. `ingestKey` is absent — a browser proves itself by origin.
export const IssuePublicConfigSchema = z.object({
    automationId: z.string(),
    title: z.string(),
    prompt: z.string(),
    thanks: z.string(),
    askEmail: z.boolean(),
    accent: z.string(),
    captureCrashes: z.boolean(),
    // "off" spelled out, not absent: a missing field meaning no challenge is how a serialization bug opens a door.
    antiBot: z.enum(["pow", "off"]),
});
export type IssuePublicConfig = z.infer<typeof IssuePublicConfigSchema>;

// A short reference to show the reporter ("we filed this as 4f3a…"), and nothing else: whether it's new, its count, who
// it woke are the owner's facts, not a stranger's.
export const IssueAcceptedSchema = z.object({ ok: z.literal(true), id: z.string() });
export type IssueAccepted = z.infer<typeof IssueAcceptedSchema>;

// Which origins loaded this intake's SDK, and which were turned away: a snippet never pasted and one pasted on a
// disallowed origin both look like "no reports".
export const IssueInstallSchema = z.object({
    origin: z.string(),
    allowed: z.boolean(),
    lastSeenAt: z.number(),
    loads: z.number(),
});
export const IssueInstallsSchema = z.object({ origins: z.array(IssueInstallSchema) });
export type IssueInstalls = z.infer<typeof IssueInstallsSchema>;
export const IssueIntakeIdParamSchema = z.object({ automationId: entryId.describe("Which intake.") });

// Constants both the editor and the route need, so a limit is visible to the owner before it is hit.

// Default daily ceiling; higher than the Front Desk's 200 since a report is only sometimes a turn (dedup decides),
// unlike a visitor message.
export const ISSUES_DAILY_MAX_DEFAULT = 2000;

// Default escalation threshold; quiet on the long tail, but a spike that starts affecting everybody crosses it almost
// immediately.
export const ISSUES_ESCALATE_AFTER_DEFAULT = 10;

// Max ingest body size; a normal report is a few KB, this leaves room for a pathological trace without becoming a file
// upload.
export const ISSUE_PAYLOAD_MAX = 96_000;
