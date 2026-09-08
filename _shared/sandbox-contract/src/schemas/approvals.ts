// approvals: things the agent prepared and may not do until the owner says yes (.intentic/config/approvals/<id>.json)
import { z } from "zod";
import { entryId } from "./internal.js";

// One queue for anything that needs a yes-click before a machine carries it out and records the outcome: an envelope
// (who, when, status, result) plus a kind-specific payload, a discriminated union. Excludes a facts inbox and a hold a
// running turn is blocked on. One JSON file per approval; the agent writes it, the daemon administers it.

export const ApprovalKindSchema = z.enum(["post", "action"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

// proposed (agent) → approved (owner) → running (set before acting, so a dead turn can't double-act) → done | failed.
// Reject deletes the file; retry re-approves a failed one.
export const ApprovalStatusSchema = z.enum(["proposed", "approved", "running", "done", "failed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// The envelope, spread into every variant (zod's discriminated union wants flat objects): a variant's own fields sit
// beside these, not under a `payload` key, so the file an agent writes stays one level deep.
const envelope = {
    // Whose name it acts under, required for anything needing a login; never guessed by the daemon.
    actsAs: entryId
        .optional()
        .describe(
            "Whose name it acts under. Needed for anything that requires being logged in, because an unwatched turn naming nobody is allowed no account at all. Never guessed: one site can be connected five times over, and picking for you means picking wrong in public with no undo.",
        ),
    // Epoch ms, the at/nextRun convention; an approved item with none is scheduled a short hold ahead by the daemon.
    scheduledAt: z
        .number()
        .optional()
        .describe(
            "When it should happen, in milliseconds. An agent may propose without one and you set it when approving; an approved item with no time goes after a short countdown you can still stop.",
        ),
    // Defaults to "proposed"; every bookkeeping field here is optional so a well-formed write never lands in `invalid`.
    status: ApprovalStatusSchema.default("proposed").describe(
        "Where it is: proposed by the agent, approved by you, being carried out, done, or failed. Rejecting is deleting it; retrying is approving a failed one again.",
    ),
    createdAt: z.number().optional().describe("When it was written, in milliseconds."),
    // Stamped with status "running"; distinguishes a run under way from one whose turn died mid-flight, which the due
    // time alone can't.
    startedAt: z
        .number()
        .optional()
        .describe(
            "When it started being carried out, in milliseconds. Needed to tell a run that is under way from one whose turn died mid-flight, which the scheduled time cannot.",
        ),
    finishedAt: z.number().optional().describe("When it was done, in milliseconds."),
    // What came back, when something did; a URL renders as a link, anything else as the plain sentence it is.
    result: z
        .string()
        .optional()
        .describe(
            "What came back, when something did: the post's own address, a confirmation number. The one thing a finished item can offer that reading it cannot.",
        ),
    error: z.string().optional().describe("Why it failed, written as a sentence for a person to read rather than as a code."),
};

/* A POST, the first kind: words that go out in public under the owner's name and cannot be recalled. */
export const PostApprovalSchema = z.object({
    kind: z.literal("post").describe("A post to publish somewhere."),
    // Bare string, not an enum, so a new platform needs no contract change.
    platform: z
        .string()
        .min(1)
        .describe("Where it should go. A plain name, so a new site needs no change here; an unknown one simply fails when it tries to post."),
    content: z.string().min(1).describe("The post itself."),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional().describe("A title, where the site wants one."),
    // A community/channel, or the URL of what this replies to; on Reddit, a thread vs a comment permalink is the room
    // vs the person.
    target: z
        .string()
        .optional()
        .describe(
            "Where on the site: a community, a channel. Or the address of the thing this replies to, in which case it is a reply, and on some sites the difference between a thread's address and one comment's is the difference between talking to the room and answering the person.",
        ),
    // Workspace-relative attachment paths, e.g. ".intentic/config/approvals/media/chart.png".
    media: z.array(z.string()).optional().describe("Anything to attach, as workspace paths."),
    ...envelope,
});
export type PostApproval = z.infer<typeof PostApprovalSchema>;

// Anything else the agent shouldn't do unasked (a booking, a purchase, a deletion). `summary`/`details` are for the
// owner; `instructions` is what the agent tells its future self, since the executing turn is fresh and has none of this
// conversation.
export const ActionApprovalSchema = z.object({
    kind: z.literal("action").describe("Something the agent will do once you say so."),
    summary: z.string().min(1).max(200).describe("What will happen, in one line: the row's headline and the confirm dialog's item."),
    // Markdown; everything the owner needs to see to say no, not just yes.
    details: z.string().optional().describe("The specifics, as Markdown: everything you would want to see before saying yes."),
    // Written for the fresh turn that executes it: names files and ids rather than "do what we discussed".
    instructions: z
        .string()
        .min(1)
        .describe(
            "What to do once approved, written for the fresh turn that will do it: names, ids and steps, since it has none of this conversation.",
        ),
    ...envelope,
});
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

// The on-disk file body, whichever kind it is.
export const ApprovalSchema = z.discriminatedUnion("kind", [PostApprovalSchema, ActionApprovalSchema]);
export type Approval = z.infer<typeof ApprovalSchema>;

// The list row / upsert input: the file body plus its filename id.
const withId = { id: entryId.describe("The approval's id.") };
export const PostApprovalSummarySchema = PostApprovalSchema.extend(withId);
export type PostApprovalSummary = z.infer<typeof PostApprovalSummarySchema>;
export const ActionApprovalSummarySchema = ActionApprovalSchema.extend(withId);
export type ActionApprovalSummary = z.infer<typeof ActionApprovalSummarySchema>;
export const ApprovalSummarySchema = z.discriminatedUnion("kind", [PostApprovalSummarySchema, ActionApprovalSummarySchema]);
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

// Filenames that failed to parse; agent-written files are a trust boundary, so these are surfaced, not silently
// dropped.
export const ApprovalsListSchema = z.object({
    approvals: z.array(ApprovalSummarySchema).describe("The queue."),
    invalid: z
        .array(z.string())
        .describe(
            "Files that could not be read at all, or name a kind this daemon does not know. Listed rather than skipped, because an agent writes these files directly and a malformed one would otherwise never run and never say why.",
        ),
});
export type ApprovalsList = z.infer<typeof ApprovalsListSchema>;
// entryId, not a bare string: the id becomes a filename under .intentic/config/approvals/.
export const ApprovalIdParamSchema = z.object({ id: entryId.describe("Which approval.") });
