// approvals: things the agent prepared and may not do until the owner says yes (.intentic/config/approvals/<id>.json)
import { z } from "zod";
import { entryId } from "./internal.js";

/* ONE QUEUE FOR EVERYTHING THAT WAITS ON A YES, and the test for what belongs in it: the agent prepared an exact
 * thing, the owner's click releases it, a machine then carries out precisely that thing, and the outcome is
 * written back. A post is the first such thing and was the whole of this file (it was `drafts`); a hotel
 * booking, a payment, a message sent under the owner's name are the same shape with a different payload, and
 * each of them arriving as its own inbox is how a product grows five tiles that all say "approve".
 *
 * So the record is an ENVELOPE plus a KIND. The envelope is what every approval shares and what the queue, the
 * badge and the daemon act on: who it acts as, when it is due, where it stands, what happened. The kind is what
 * the row draws and the daemon dispatches on, a discriminated union so a new kind is one variant here, one
 * body component in the extension and one executor in the daemon, and nothing else moves.
 *
 * What does NOT belong here, and why the line is drawn where it is: an inbox of FACTS (the issues queue, where
 * a crash arrived and the owner's verbs are resolve / ignore / investigate) has no prepared thing to release,
 * and a hold a RUNNING turn is blocked on (a permission card, a spend offer) lives in the conversation, because
 * a queue is the wrong latency for a click somebody is spinning on.
 *
 * One JSON file per approval. The AGENT creates them with its normal file tools, it can't call daemon routes,
 * the same split as the environment proposal, while the daemon edits/deletes them on the owner's behalf, so
 * the two writers never share a file. The id IS the filename (entryId charset ⇒ path-safe); the body never
 * carries it. */

export const ApprovalKindSchema = z.enum(["post", "action"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

/* proposed (agent) → approved (owner) → running (executor, set BEFORE acting so a dead turn can't do it twice)
 * → done | failed. Reject = delete the file; retry = re-approve a failed one. The names are deliberately not a
 * post's ("posting", "posted"): they are read by every kind, and a booking is not "posted". */
export const ApprovalStatusSchema = z.enum(["proposed", "approved", "running", "done", "failed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/* THE ENVELOPE, spread into every variant below (zod's discriminated union wants flat objects, not an extended
 * base), which is also why a variant's own fields sit beside these rather than under a `payload` key: the file
 * an agent writes stays one level deep, and "which fields are mine" is answered by the variant's schema. */
const envelope = {
    /* WHOSE NAME THIS ACTS UNDER, a PersonaSchema id, handed to the executing turn as AgentTurnSchema.actsAs.
     * Required in practice for every post outside DIRECT_PUBLISH_PLATFORMS, and the reason is the whole shape
     * of turnPersona: acting through a browser needs a logged-in account, and an UNATTENDED turn that names no
     * persona is denied every account there is. Without this field the executor could only wake such a turn,
     * one structurally unable to reach the login the post needs, which read from inside the turn as "this
     * account is not connected" and cost two approved posts before anyone traced it back here.
     *
     * A PERSONA RATHER THAN AN ACCOUNT ID, because that is the vocabulary the rest of the system already speaks:
     * `actsAs` is the only pin turnPersona honours, and a card carries the workspace scope the turn also needs to
     * write this file's own status back. Naming the account directly would invent a second way to say the same
     * thing, and the two would disagree the first time a card's accounts changed.
     *
     * The daemon never guesses it. One site can be connected several times over, five Reddit logins here, and
     * picking for the owner means picking wrong in public, with no undo. A post that needs a turn and names
     * nobody is failed with that sentence instead of sent. An ACTION that names nobody runs with no accounts,
     * which is a legitimate choice for work that needs none. */
    actsAs: entryId
        .optional()
        .describe(
            "Whose name it acts under. Needed for anything that requires being logged in, because an unwatched turn naming nobody is allowed no account at all. Never guessed: one site can be connected five times over, and picking for you means picking wrong in public with no undo.",
        ),
    // Suggested time (epoch ms, the at/nextRun convention). Optional, the agent may propose without a date and
    // the owner sets one at approval; an approved item with no date is dated one hold ahead by the daemon.
    scheduledAt: z
        .number()
        .optional()
        .describe(
            "When it should happen, in milliseconds. An agent may propose without one and you set it when approving; an approved item with no time goes after a short countdown you can still stop.",
        ),
    // Agent-written files only need the kind's own fields; status defaults, the rest are optional, so a
    // well-formed proposal never lands in `invalid` just for omitting bookkeeping fields.
    status: ApprovalStatusSchema.default("proposed").describe(
        "Where it is: proposed by the agent, approved by you, being carried out, done, or failed. Rejecting is deleting it; retrying is approving a failed one again.",
    ),
    createdAt: z.number().optional().describe("When it was written, in milliseconds."),
    // When execution STARTED, stamped with status "running". The executor needs it to tell a run that is under
    // way from one whose turn died mid-flight, and those two are indistinguishable from the due time: a post
    // scheduled for last week is not a post that has been sending since last week.
    startedAt: z
        .number()
        .optional()
        .describe(
            "When it started being carried out, in milliseconds. Needed to tell a run that is under way from one whose turn died mid-flight, which the scheduled time cannot.",
        ),
    finishedAt: z.number().optional().describe("When it was done, in milliseconds."),
    // What came back, when something did: a post's own address, a booking's confirmation. The one thing a done
    // row can offer that reading the proposal cannot: the result itself, to go and look at. A URL is drawn as
    // a link; anything else as the sentence it is.
    result: z
        .string()
        .optional()
        .describe(
            "What came back, when something did: the post's own address, a confirmation number. The one thing a finished item can offer that reading it cannot.",
        ),
    // Why it failed; set with status "failed". Written for the owner to read in the queue, so it is a sentence
    // rather than a code.
    error: z.string().optional().describe("Why it failed, written as a sentence for a person to read rather than as a code."),
};

/* A POST, the first kind: words that go out in public under the owner's name and cannot be recalled. */
export const PostApprovalSchema = z.object({
    kind: z.literal("post").describe("A post to publish somewhere."),
    // Which skill posts it: "x" | "reddit" | "youtube" | "discord" | …, a bare string so new platforms need
    // no contract change; an unknown platform simply fails at posting time.
    platform: z
        .string()
        .min(1)
        .describe("Where it should go. A plain name, so a new site needs no change here; an unknown one simply fails when it tries to post."),
    content: z.string().min(1).describe("The post itself."),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional().describe("A title, where the site wants one."),
    /* Where on the platform: subreddit / Discord channel id / community. OR the URL of the thing this post
     * replies to. A URL target means the post is a reply, and on reddit the difference between a thread's
     * address and one comment's permalink is the difference between talking to the room and answering the
     * person: the publisher opens exactly this and replies where it lands. */
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

/* AN ACTION, the general kind: anything else the agent is about to do that it should not do unasked. A
 * booking, a purchase, a message to a person, a deletion that cannot be undone. The agent writes what it will
 * do in words the owner reads (`summary`, `details`), and what it will tell ITSELF to do once released
 * (`instructions`), because the turn that carries it out is a fresh one, hours later, with none of the
 * conversation that led here. Executed by an agent turn, always: there is no typed door for "whatever it is". */
export const ActionApprovalSchema = z.object({
    kind: z.literal("action").describe("Something the agent will do once you say so."),
    summary: z.string().min(1).max(200).describe("What will happen, in one line: the row's headline and the confirm dialog's item."),
    // Markdown. The specifics a yes is being asked for: the hotel and the dates, the amount and the account,
    // the exact message and its recipient. Everything the owner has to see to be able to say no.
    details: z.string().optional().describe("The specifics, as Markdown: everything you would want to see before saying yes."),
    // What the executing turn is told. Written by the agent for its later self, so it names files, ids and
    // steps rather than saying "do what we discussed".
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

// `invalid` = filenames that failed to parse. Agent-written files are a trust boundary, without this a typo'd
// approval (or one of a kind this daemon does not know) would silently never run.
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
