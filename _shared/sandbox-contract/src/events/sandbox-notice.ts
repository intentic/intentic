import { z } from "zod";

// The sandbox's own notice rows (a land, a hold, a renewal, a stop), as a code and the facts they were worded from. The
// row's `text` stays the English sentence, which older apps, stored transcripts and agents reading their own history
// go on reading; `noticeCode` beside it is what lets an app say the same thing in the reader's language and words.

// On the wire a code is any string and its facts a flat record: a transcript page carrying a code newer than its reader
// still parses, and that reader draws `text`. The codes this build writes, with their facts typed, are
// SandboxNoticeSchema below.
export const NoticeCodeSchema = z.object({
    code: z.string().describe("Which of the sandbox's notices this row is, by name. A reader that does not know the name shows the row's text."),
    params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe("The facts the notice was worded from, by name: counts, names, and the provider's own sentence where the notice quotes one."),
});
export type NoticeCode = z.infer<typeof NoticeCodeSchema>;

const count = z.number().int().nonnegative();

// A failure's own sentence, which the notice's clause follows: the provider's words, or the sandbox's under `error`, its
// failure code, for a reader that words a failure it knows itself.
const failure = {
    message: z.string(),
    error: z.string().optional(),
};

// The re-runs a resumed turn's row can name (events/resume.ts); a reason a reader does not know draws the row's text.
const ResumeNoticeReasonSchema = z.enum(["auth", "outage", "restart", "stopped", "limit", "switched", "carried", "refused", "door", "overflow", "flagged", "continued"]);
export type ResumeNoticeReason = z.infer<typeof ResumeNoticeReasonSchema>;

// Every code this build writes, one per sentence shape, each with the facts that shape needs.
export const SandboxNoticeSchema = z.discriminatedUnion("code", [
    z.object({ code: z.literal("compacted") }),
    z.object({ code: z.literal("stopped") }),
    // The branch was rebased onto `commits` new commits, and/or could not be in the repos named in `blocked`.
    z.object({ code: z.literal("synced"), params: z.object({ commits: count, blocked: z.string().optional() }) }),
    z.object({ code: z.literal("intoParent") }),
    z.object({ code: z.literal("intoParentClash"), params: z.object({ files: count }) }),
    z.object({ code: z.literal("landHeld") }),
    z.object({ code: z.literal("landConflict"), params: z.object({ files: count, repos: z.string() }) }),
    // `deps` dependencies the turn added or changed, installing now, or `queued` behind any other install.
    z.object({ code: z.literal("landed"), params: z.object({ deps: count.optional(), queued: z.boolean().optional() }).optional() }),
    z.object({ code: z.literal("retrying"), params: z.object({ ...failure, attempt: count, of: count }) }),
    z.object({ code: z.literal("retried"), params: z.object({ ...failure, made: count, of: count }) }),
    z.object({ code: z.literal("outageWaiting"), params: z.object(failure) }),
    z.object({ code: z.literal("renewing"), params: z.object(failure) }),
    z.object({ code: z.literal("renewalWithdrawn"), params: z.object(failure) }),
    z.object({ code: z.literal("reconnect"), params: z.object(failure) }),
    z.object({ code: z.literal("undelivered"), params: z.object({ ...failure, unattended: z.boolean().optional() }) }),
    // A turn the sandbox kept whole, its message above; `memory` when a memory hold kept it.
    z.object({ code: z.literal("kept"), params: z.object({ ...failure, memory: z.boolean().optional() }) }),
    z.object({ code: z.literal("memoryHeld"), params: z.object(failure) }),
    // A failure the sandbox names by code and adds nothing to.
    z.object({ code: z.literal("failed"), params: z.object(failure) }),
    z.object({ code: z.literal("questionDismissed") }),
    z.object({ code: z.literal("planApproved") }),
    z.object({ code: z.literal("keptPlanning") }),
    // `note` is the agent's own words; `every` the interval, already worded ("5m").
    z.object({ code: z.literal("watching"), params: z.object({ note: z.string(), every: z.string() }) }),
    z.object({ code: z.literal("restartInterrupted") }),
    // A turn that picked up a conversation the sandbox kept warm: `tokens` read from the cache ("305k"), or for
    // keptCold sent again, after `span` ("2h 5m") and `refreshes` refreshes.
    z.object({ code: z.literal("keptWarm"), params: z.object({ tokens: z.string(), span: z.string(), refreshes: count }) }),
    z.object({ code: z.literal("keptCold"), params: z.object({ tokens: z.string(), span: z.string(), refreshes: count }) }),
    // A turn sent thin for a small window ("16k"): what was left out, and whether the base instructions were swapped too.
    z.object({ code: z.literal("contextTrim"), params: z.object({ window: z.string(), omitted: z.string().optional(), base: z.boolean() }) }),
    z.object({ code: z.literal("resumed"), params: z.object({ reason: ResumeNoticeReasonSchema }) }),
    // An agent's own dependency install starting: into its conversation's own copy (`ownCopy`) or the main tree; the
    // workspace root (`root`) and up to three project folders named (`projects`, each with its slash, already joined),
    // and how many `more` were not named.
    z.object({
        code: z.literal("installing"),
        params: z.object({ ownCopy: z.boolean(), root: z.boolean().optional(), projects: z.string().optional(), more: count.optional() }),
    }),
]);
export type SandboxNotice = z.infer<typeof SandboxNoticeSchema>;

/** The wire form of one of this build's notices, facts nobody gave left off rather than sent as nothing. */
export const noticeCode = (notice: SandboxNotice): NoticeCode => {
    if (!("params" in notice) || notice.params === undefined) {
        return { code: notice.code };
    }
    const params = Object.fromEntries(
        Object.entries(notice.params).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
    );
    return Object.keys(params).length === 0 ? { code: notice.code } : { code: notice.code, params };
};

/** One of this build's notices, read off a row; undefined for a row without one, or with a code or facts this build does not know. */
export const sandboxNoticeOf = (row: { readonly noticeCode?: NoticeCode | undefined }): SandboxNotice | undefined =>
    row.noticeCode === undefined ? undefined : SandboxNoticeSchema.safeParse(row.noticeCode).data;
