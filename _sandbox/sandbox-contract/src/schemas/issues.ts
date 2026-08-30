// issues: inbound bug reports from the owner's own sites and apps, grouped by fingerprint
// (.intentic/records/issues/<fingerprint>.json, one file per group)
import { z } from "zod";
import { entryId } from "./internal.js";

/* WHAT A USER'S CRASH LOOKS LIKE BY THE TIME AN AGENT CAN ACT ON IT.
 *
 * Three shapes live here and the split between them is the whole design:
 *
 *   IssueReportSchema  what a stranger's browser POSTs to /intake/<id>/report. UNTRUSTED, every field of it,
 *                      and bounded field by field because the endpoint is public and the body is a stack trace
 *                      somebody else's machine wrote.
 *   IssueSchema        what the daemon KEEPS: one group per fingerprint, with a count, a first/last seen and
 *                      the most recent sample. A crash loop is one of these, not ten thousand.
 *   IssuesConfigSchema what the owner configures on the automation, and IssuePublicConfigSchema the subset the
 *                      SDK is allowed to read back. Named field by field there, never by omission, the same
 *                      rule WebchatConfig's public half is built on.
 *
 * The SDK imports these as TYPES ONLY (`import type`), so zod never reaches a visitor's browser, which is why
 * the wire shapes live in this package beside the stored ones rather than being re-typed in the bundle. */

// What kind of thing arrived. `crash` and `detection` GROUP (one fingerprint, a rising count); `report` never
// does, because two people describing the same annoyance in their own words are two things to read.
export const IssueKindSchema = z.enum(["crash", "report", "detection"]);
export type IssueKind = z.infer<typeof IssueKindSchema>;

/* One thing that happened before the crash. Deliberately a flat {at, kind, message} rather than a per-source
 * union: the value of a breadcrumb is being READ in order next to the others, and a shape the SDK can produce
 * for a console line, a failed fetch and a route change alike is one the agent can render as a timeline
 * without knowing which instrumentations the site switched on. */
export const IssueBreadcrumbSchema = z.object({
    at: z.number().describe("When, in milliseconds."),
    kind: z.string().max(40).describe("What sort of thing it was: a console line, a request, a click, a route change."),
    message: z.string().max(300).describe("What it said, already truncated by the SDK."),
});
export type IssueBreadcrumb = z.infer<typeof IssueBreadcrumbSchema>;

// How much of the reporter we are willing to believe: nothing. Both fields are typed by whoever is reporting,
// so they reach the model beside the content rather than above it, exactly as a Front Desk visitor's
// `unverifiedDisplayName` does. There is no signed identity on this endpoint and there should not be one: a
// crash handler fires on a dying page, where no sign-in ceremony can run.
export const IssueReporterSchema = z.object({
    email: z.string().max(320).optional().describe("An address they typed, to reach them about it. Unverified."),
    name: z.string().max(200).optional().describe("A name they typed. Unverified, and never identity."),
});
export type IssueReporter = z.infer<typeof IssueReporterSchema>;

// A small bag of host-supplied strings (route, app version, locale, tenant). Bounded in both dimensions
// because it is the one open-ended field on a public endpoint, and an unbounded map is a storage bug waiting
// for the first person who loops over it.
const CONTEXT_KEYS_MAX = 20;
const IssueContextSchema = z
    .record(z.string().max(60), z.string().max(300))
    .refine((context) => Object.keys(context).length <= CONTEXT_KEYS_MAX, { message: `at most ${CONTEXT_KEYS_MAX} context entries` });

/* ONE REPORT, AS IT ARRIVES. Everything optional except `kind` and `message`, because the three kinds carry
 * genuinely different evidence and a schema that demanded the union of them would refuse the commonest case:
 * `window.onerror` in an old browser, which has a message and very little else. */
export const IssueReportSchema = z.object({
    kind: IssueKindSchema.describe("A crash the SDK caught, something a person wrote in, or a problem the SDK noticed on its own."),
    message: z.string().min(1).max(1000).describe("The error's own message, or the headline of what a person reported."),
    stack: z.string().max(20_000).optional().describe("The stack, verbatim from the browser."),
    url: z.string().max(2000).optional().describe("Where it happened: the page's address, or a screen name in an app."),
    /* THE ONE FIELD THAT REPLACES AN ENTIRE INTEGRATION. The agent has the repository, so a build's sha or tag
     * is enough to check that commit out and read the real frames; there is nothing to upload, no artifact
     * store, and no sourcemap pipeline to keep in step with a deploy. A site that sets nothing here still gets
     * a grouped, readable issue: it just costs the agent a guess about which build it came from. */
    release: z.string().max(200).optional().describe("Which build it came from: a commit sha or a tag. With it the agent reads your real source rather than minified frames."),
    userAgent: z.string().max(400).optional().describe("What the browser said it was."),
    description: z.string().max(5000).optional().describe("What the person typed, when a person is the one reporting."),
    reporter: IssueReporterSchema.optional().describe("Who says they are reporting it. Unverified by construction."),
    breadcrumbs: z.array(IssueBreadcrumbSchema).max(40).optional().describe("What happened just before, oldest first."),
    context: IssueContextSchema.optional().describe("Whatever else the app attached: a route, a version, a locale."),
    /* The host's own grouping override, Sentry's convention and worth keeping: an app that knows two crashes
     * are the same thing (or knows one crash is really two) can say so, and the daemon groups on this instead
     * of on the stack. It is hashed like everything else, never used as a filename directly. */
    fingerprint: z.string().max(200).optional().describe("Group by this instead of by the stack, when your app knows better than the stack does."),
});
export type IssueReport = z.infer<typeof IssueReportSchema>;

/* The body POSTed to /intake/<id>/report: the report plus the two things the GATE needs and the report itself
 * has no business carrying, a client id to rate-limit against and the anti-bot answer. Kept out of
 * IssueReportSchema so that what gets STORED (the sample) is the evidence and not the doorman's paperwork. */
export const IssueIngestSchema = z.object({
    report: IssueReportSchema,
    // The SDK's own per-browser id (localStorage). Not a secret and not identity, anyone can mint one: it is
    // the key the per-minute limit counts against, so one runaway tab cannot spend the whole day's budget.
    clientId: z.string().min(1).max(200).describe("The SDK's own id for this browser. Not a secret: it is what the rate limit counts against."),
    // Only for `report`, and only when the automation asks for a proof of work: a crash fires on a dying page,
    // where there is no second to spend on a puzzle and no user to wait for it.
    powNonce: z.string().max(400).optional(),
    // Minted by the owner, pasted into a mobile or server SDK that has no Origin header for the allowlist to
    // read. An abuse LABEL rather than a secret (it ships inside a mobile binary and can be pulled out of one):
    // the real ceilings are the dedup, the rate limit and the daily budget.
    key: z.string().max(200).optional(),
});
export type IssueIngest = z.infer<typeof IssueIngestSchema>;

/* Where a group stands with the owner. `investigating` is set by the daemon when a turn is actually started
 * for it (from a wake or from the Investigate button), never guessed: it is the difference between "nobody has
 * looked at this" and "something is looking at it right now", which is the question a triage inbox is for. */
export const IssueStatusSchema = z.enum(["open", "investigating", "resolved", "ignored"]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

// One agent turn started for this issue. The conversation id is the link: the fleet board already knows how to
// open one, so the inbox does not have to store anything about the run beyond which conversation it became.
export const IssueRunSchema = z.object({
    conversationId: z.string().describe("The conversation this run became."),
    at: z.number().describe("When it started, in milliseconds."),
    // What the count stood at when this run was started, so a recurrence after a fix reads as "it came back",
    // not as "someone already looked at this".
    atCount: z.number().describe("How many times it had happened when this run started."),
});
export type IssueRun = z.infer<typeof IssueRunSchema>;

/* ONE GROUP. The id is the fingerprint and is the FILENAME, never in the body (json-dir.ts owns that rule), so
 * a body that disagrees with its own grouping cannot be written. */
export const IssueSchema = z.object({
    kind: IssueKindSchema,
    // The one-line headline the inbox lists it under, derived from the report rather than typed, so two
    // recurrences of one crash cannot be filed under two names.
    title: z.string().min(1).max(300).describe("The one line this is listed under."),
    culprit: z.string().max(300).optional().describe("The frame it came from, when the stack named one."),
    // Which issues automation received it. A workspace can run several (one per site), and the inbox is one
    // list across all of them, so the group has to say which door it came in through.
    automationId: entryId.describe("Which intake received it."),
    // The site or app it came from, as the browser's Origin or the SDK's declared one; absent for a keyed
    // client (a mobile app, a server) that has no origin to send.
    origin: z.string().max(400).optional().describe("Which site it came from."),
    firstSeen: z.number().describe("When it first happened, in milliseconds."),
    lastSeen: z.number().describe("When it last happened, in milliseconds."),
    count: z.number().describe("How many times this exact thing has arrived."),
    status: IssueStatusSchema.default("open").describe("Where it stands with you."),
    statusAt: z.number().optional().describe("When the status last changed, in milliseconds."),
    release: z.string().max(200).optional().describe("The build the latest one came from."),
    // The most recent event in full. The LATEST rather than the first, deliberately: when a crash is still
    // happening, what it looks like now is what a fix has to reproduce, and the first one is often from a
    // build that no longer exists.
    sample: IssueReportSchema.describe("The most recent one, in full."),
    /* How many arrivals had been counted the last time this group WOKE an agent. The whole of the escalation
     * rule lives in this one number: a group fires once when it is new, and again only when it has moved this
     * far past its last firing. Stored rather than derived, because "how many since the last wake" is not
     * recoverable from a count and a timestamp after a restart. */
    firedAt: z.number().optional().describe("What the count stood at the last time this woke an agent."),
    runs: z.array(IssueRunSchema).max(20).optional().describe("The turns started for it."),
});
export type Issue = z.infer<typeof IssueSchema>;

// The list row: the stored group plus its filename id (the fingerprint).
export const IssueSummarySchema = IssueSchema.extend({ id: entryId.describe("The issue's id, which is its fingerprint.") });
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

// `invalid` is the same trust-boundary confession the drafts list makes, for the opposite reason: nothing but
// the daemon writes these, so a file in here that will not parse is a BUG in this daemon or a half-written
// volume, and either is worth seeing rather than silently skipping.
export const IssuesListSchema = z.object({
    issues: z.array(IssueSummarySchema).describe("The inbox, most recently seen first."),
    invalid: z.array(z.string()).describe("Files in the issues directory that could not be read at all."),
});
export type IssuesList = z.infer<typeof IssuesListSchema>;

export const IssueIdParamSchema = z.object({ id: entryId.describe("Which issue.") });
// Triage: the owner moving one row. `investigating` is not offered here, the daemon sets it when a turn
// actually starts, and letting a click claim it would make the one status that means something a lie.
export const IssueStatusInputSchema = z.object({
    id: entryId.describe("Which issue."),
    status: z.enum(["open", "resolved", "ignored"]).describe("Where it now stands with you."),
});
export type IssueStatusInput = z.infer<typeof IssueStatusInputSchema>;

/* ---- the automation's own settings ----
 *
 * Present only on `issues` listener automations, ignored on every other trigger, the shape WebchatConfig
 * already established. `allowedOrigins` is NOT here: it lives on the trigger, because it is the admission gate
 * the ingest route reads rather than a rendering choice, and one gate in two places is one gate. */
export const IssuesConfigSchema = z.object({
    /* The key a client with no Origin presents (a mobile app, a server, a desktop build). Minted by the daemon
     * on upsert like the event webhook's token, and for the same reason: every sender supports "paste this
     * string", and nothing else is available to a caller with no identity and no browser.
     *
     * It is an abuse LABEL, not a secret, and the difference matters: it ships inside a binary anyone can pull
     * apart. What it buys is that a leaked key can be rotated in one click while the origin allowlist keeps
     * covering the web. The ceilings are what actually bound the damage. */
    ingestKey: z.string().min(1).optional().describe("The key an app with no website origin presents. Rotate it freely: the limits, not this, are what bound the damage."),
    /* Whether a browser with no allowed origin may still report by presenting the key. Off by default: the
     * commonest way an intake gets abused is its key ending up in a public web bundle, and the allowlist is
     * the thing that stops that mattering. */
    keyFromBrowsers: z.boolean().optional().describe("Let a browser report with the key alone, rather than only from a site you listed. Off unless you need it."),
    // The whole intake's ceiling per UTC day, counted in reports that reach the store. Absent ⇒
    // ISSUES_DAILY_MAX_DEFAULT, never uncapped, for the reason the Front Desk's own daily cap gives.
    dailyReportMax: z.number().int().positive().optional().describe("How many reports a day this intake accepts at all."),
    /* HOW FAR A KNOWN CRASH HAS TO GO BEFORE IT INTERRUPTS ANYONE AGAIN. A group wakes an agent when it is
     * new, and after that only when its count has grown by this much since the last wake. Absent ⇒
     * ISSUES_ESCALATE_AFTER_DEFAULT.
     *
     * This is the number that makes the whole product safe to leave on. Without it a crash loop on one popular
     * page is an agent turn per affected browser, which is a bill rather than a bug report. */
    escalateAfter: z.number().int().positive().optional().describe("How many more times a known crash must happen before it wakes an agent again."),
    // A proof-of-work puzzle on WRITTEN REPORTS only (a crash has no second to spend and no user to wait for
    // it). Absent ⇒ off, leaving the origin allowlist and the ceilings as the whole boundary.
    antiBot: z.enum(["pow"]).optional().describe("Make a person's browser solve a small puzzle before it accepts a written report."),
    /* ---- the report dialog's chrome, all of it public by construction ---- */
    title: z.string().max(80).optional().describe("The dialog's heading."),
    prompt: z.string().max(300).optional().describe("The line above the box they type in."),
    thanks: z.string().max(300).optional().describe("What it says once they have sent it."),
    askEmail: z.boolean().optional().describe("Ask for an address to reply to. Optional for them either way."),
    // A hex colour, for the reason WebchatConfig's `accent` is one: the SDK derives a hover and a focus ring
    // from its channels rather than only painting it.
    accent: z
        .string()
        .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "accent must be a hex colour, e.g. #e47100")
        .optional(),
    // Whether the SDK arms window.onerror / unhandledrejection at all. Absent ⇒ on: a site that embedded a
    // crash reporter meant to report crashes.
    captureCrashes: z.boolean().optional().describe("Catch uncaught errors automatically, as well as what people write in."),
});
export type IssuesConfig = z.infer<typeof IssuesConfigSchema>;

/* What the SDK is told about itself, fully RESOLVED daemon-side so the bundle carries no fallback logic. Every
 * field is named here rather than spread from the config: a secret added to IssuesConfig later is invisible to
 * a stranger's browser until somebody deliberately lists it, which is the property this shape exists for.
 * `ingestKey` is conspicuously absent, a browser proves itself by its origin. */
export const IssuePublicConfigSchema = z.object({
    automationId: z.string(),
    title: z.string(),
    prompt: z.string(),
    thanks: z.string(),
    askEmail: z.boolean(),
    accent: z.string(),
    captureCrashes: z.boolean(),
    // "off" spelled out rather than left absent, for the reason the Front Desk's is: the SDK branches on it,
    // and a missing field meaning "no challenge" is how one serialization bug becomes an open door.
    antiBot: z.enum(["pow", "off"]),
});
export type IssuePublicConfig = z.infer<typeof IssuePublicConfigSchema>;

// The proof-of-work challenge, the same shape and the same solver as the Front Desk's.
export const IssueChallengeSchema = z.object({ salt: z.string(), difficulty: z.number().int().positive() });
export type IssueChallenge = z.infer<typeof IssueChallengeSchema>;

/* What the intake answers with. A short reference the reporter can be shown ("we filed this as 4f3a…"), and
 * nothing else: whether this crash is new, how often it has happened and whether it woke anybody are the
 * owner's facts, and the caller is a stranger's browser. */
export const IssueAcceptedSchema = z.object({ ok: z.literal(true), id: z.string() });
export type IssueAccepted = z.infer<typeof IssueAcceptedSchema>;

/* Which origins have loaded this intake's SDK, and which were turned away. The Front Desk's install probe,
 * whole, because the setup mistake is identical and so is the silence it produces: a snippet that was never
 * pasted, and one pasted on an origin the allowlist does not have, are both "an intake with no reports". */
export const IssueInstallSchema = z.object({
    origin: z.string(),
    allowed: z.boolean(),
    lastSeenAt: z.number(),
    loads: z.number(),
});
export const IssueInstallsSchema = z.object({ origins: z.array(IssueInstallSchema) });
export type IssueInstalls = z.infer<typeof IssueInstallsSchema>;
export const IssueIntakeIdParamSchema = z.object({ automationId: entryId.describe("Which intake.") });

/* ---- the numbers both ends need ----
 *
 * Here rather than beside the route that enforces them, for WebchatConfig's reason: the automation editor has
 * to be able to show the owner what they are already protected by, and a limit that is invisible until it is
 * hit gets filed as a bug. */

/* The daily ceiling an intake gets when its owner sets none. Larger than the Front Desk's 200 because the unit
 * is different: a report is a file write and only SOMETIMES an agent turn (dedup decides), where a visitor
 * message is always a turn. High enough that a real product's bad afternoon fits inside it, low enough that a
 * script pointed at the endpoint stops being interesting within seconds. */
export const ISSUES_DAILY_MAX_DEFAULT = 2000;

/* How much a known crash has to grow before it wakes anybody again. Ten is chosen to be quiet on the tail (one
 * more person hitting a known bug is not news) and prompt on a spike: a regression that starts affecting
 * everybody crosses it almost at once, which is exactly when the second wake is worth having. */
export const ISSUES_ESCALATE_AFTER_DEFAULT = 10;

// How much of one ingest body the daemon will read. A stack plus forty breadcrumbs plus a description is a few
// kilobytes; this leaves room for a pathological framework trace without letting the endpoint be a file upload.
export const ISSUE_PAYLOAD_MAX = 96_000;
