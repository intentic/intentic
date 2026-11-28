// Bug reports from the owner's own sites and apps, as they travel: what the reporter SDK sends, what an intake's
// automation is configured with, and what one sandbox of the owner's account reports to another. The inbox they are
// grouped into (.intentic/records/issues/, one file per fingerprint) is the issues extension's own since 2026-11-26, and
// so are its shapes.
import { z } from "zod";

// `IssueReportSchema` (untrusted, from a stranger's POST), and `IssuesConfigSchema`/`IssuePublicConfigSchema` (owner
// settings vs. what the SDK reads back). Imported as types only, so zod never reaches a browser.

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

// POSTed to an intake's report door: the report plus what the gate needs (client id, anti-bot answer) but never stores,
// which keeps the stored sample pure evidence, not doorman's paperwork. Since 2026-11-26 the door is the issues
// extension's (/door/intentic.issues/<id>/report), where the key travels as `?key=` and a proof of work in the door's
// headers; `powNonce` and `key` are what an SDK from before then puts in the body at /intake/<id>/report, which the
// daemon still forwards there.
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

// Who reported it, when the reporter was another sandbox on the owner's account (account-level report routing). Read
// from the platform-signed pass, except `conversationId`, which the sending daemon names for its own conversation.
export const IssueSenderSchema = z.object({
    sandboxId: z.string().max(40).describe("The reporting sandbox's id."),
    sandboxName: z.string().max(120).describe("Its name on your account."),
    address: z.string().max(300).optional().describe("Its address, when the report came as a message from a contact (docs/architecture/messages.md)."),
    project: z.string().max(200).describe("The project it reported about, as this sandbox claims it."),
    conversationId: z.string().max(120).optional().describe("The conversation over there that reported it."),
    person: z
        .string()
        .max(254)
        .optional()
        .describe("The person that conversation acts for, as the platform signed it and this sandbox's roster knows them: attribution only."),
    crossesOrg: z
        .object({
            from: z.object({ id: z.string().max(64), name: z.string().max(120) }).optional(),
            to: z.object({ id: z.string().max(64), name: z.string().max(120) }).optional(),
        })
        .optional()
        .describe(
            "Set when the reporting sandbox and this one are not in the same organisation, as the platform signed it: `from` is the reporter's organisation, `to` this sandbox's; a side in none is absent.",
        ),
});
export type IssueSender = z.infer<typeof IssueSenderSchema>;

// POSTed to /account/report by another of the owner's sandboxes, under a pass (sandbox-contract policy/sandbox-pass.ts).
// Only what groups: an agent's problem is a `detection` (or a `crash` with a stack), never an ungrouped `report`, so five
// sandboxes seeing one broken thing fold into one issue. `times` carries repeats the sender folded while it could not
// deliver.
export const AccountProblemSchema = IssueReportSchema.extend({ kind: z.enum(["crash", "detection"]) });
export type AccountProblem = z.infer<typeof AccountProblemSchema>;
export const AccountReportSchema = z.object({
    report: AccountProblemSchema,
    conversationId: z.string().max(120).optional(),
    times: z.number().int().min(1).max(10_000).optional(),
});
export type AccountReport = z.infer<typeof AccountReportSchema>;

// (2026-11-26) An admitted account report as the receiving door hands it to the extension that keeps the issues inbox
// (its `account-report` fire handler, the fire's payload as JSON): the problem, how many arrivals it stands for, and the
// sender as the platform's pass named it, which the inbox keeps outside everything the reporter wrote.
export const AccountReportFiledSchema = z.object({
    report: AccountProblemSchema,
    times: z.number().int().min(1).max(10_000),
    sender: IssueSenderSchema,
});
export type AccountReportFiled = z.infer<typeof AccountReportFiledSchema>;

// The sending side, over loopback from the `projects report` command: a problem for whichever sandbox on the owner's
// account claims `project`, and what came of it (delivered now, waiting in the outbox, or refused for good).
export const AccountSendSchema = z.object({
    project: z.string().min(1).max(300),
    report: AccountProblemSchema,
});
export type AccountSend = z.infer<typeof AccountSendSchema>;
export const AccountSendOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("delivered"), to: z.string(), id: z.string() }),
    z.object({ state: z.literal("queued"), to: z.string().optional(), reason: z.string(), times: z.number() }),
    z.object({ state: z.literal("refused"), reason: z.string() }),
]);
export type AccountSendOutcome = z.infer<typeof AccountSendOutcomeSchema>;
export const AccountOutboxSchema = z.object({
    waiting: z.array(
        z.object({
            id: z.string(),
            project: z.string(),
            title: z.string(),
            times: z.number(),
            firstAt: z.number(),
            nextAt: z.number(),
            lastError: z.string().optional(),
        }),
    ),
});
export type AccountOutbox = z.infer<typeof AccountOutboxSchema>;
export const AccountProjectsSchema = z.object({ projects: z.array(z.string()) });

// Present only on `issues` listener automations. `allowedOrigins` is not here: it lives on the trigger, since the
// ingest route reads it as the admission gate, not a rendering choice.
export const IssuesConfigSchema = z.object({
    // Ingest key lives in the secrets store (`AutomationSummary.ingestKey`), not here — an abuse label the origin
    // allowlist and ceilings actually bound, not a secret. `keyFromBrowsers` left for the listener trigger (2026-11-26),
    // where any extension's public door reads it; the automations file's conversion moves a stored one there. It stays
    // accepted here, read by nothing, because a runner of an older release still speaks it inside an automation need's
    // event (the runner door lags in the field: _tools/checks/lib/release-doors.mjs).
    keyFromBrowsers: z
        .boolean()
        .optional()
        .describe("Deprecated: moved to the listener trigger. Let a browser report with the key alone, rather than only from a site you listed."),
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

// Constants both the editor and the route need, so a limit is visible to the owner before it is hit.

// Default daily ceiling; higher than the Visitor chat's 200 since a report is only sometimes a turn (dedup decides),
// unlike a visitor message.
export const ISSUES_DAILY_MAX_DEFAULT = 2000;

// Default escalation threshold; quiet on the long tail, but a spike that starts affecting everybody crosses it almost
// immediately.
export const ISSUES_ESCALATE_AFTER_DEFAULT = 10;

// Max ingest body size; a normal report is a few KB, this leaves room for a pathological trace without becoming a file
// upload.
export const ISSUE_PAYLOAD_MAX = 96_000;
