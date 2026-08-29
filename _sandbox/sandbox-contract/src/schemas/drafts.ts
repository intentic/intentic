// drafts: agent-proposed posts awaiting owner approval (.intentic/config/drafts/<id>.json)
import { z } from "zod";
import { entryId } from "./internal.js";
// One JSON file per draft. The AGENT creates drafts with its normal file tools, it can't call daemon routes,
// the same split as the environment proposal, while the daemon edits/deletes them on the owner's behalf, so
// the two writers never share a file. The id IS the filename (entryId charset ⇒ path-safe); the body never
// carries it. Posting is the agent's job too (there is no typed publish path): a "publish approved drafts"
// automation wakes the agent for due drafts, which posts via the platform skills and flips the status.

export const DraftStatusSchema = z.enum(["proposed", "approved", "posting", "posted", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
// The on-disk file body. proposed (agent) → approved (owner) → posting (publisher, set BEFORE acting so a dead
// turn can't double-post) → posted | failed. Reject = delete the file; retry = re-approve a failed draft.
export const DraftSchema = z.object({
    // Which skill posts it: "x" | "reddit" | "youtube" | "discord" | …, a bare string so new platforms need
    // no contract change; an unknown platform simply fails at posting time.
    platform: z
        .string()
        .min(1)
        .describe("Where it should go. A plain name, so a new site needs no change here; an unknown one simply fails when it tries to post."),
    /* WHOSE NAME THIS GOES OUT UNDER, a PersonaSchema id, handed to the publish turn as AgentTurnSchema.actsAs.
     * Required in practice for every platform outside DIRECT_PUBLISH_PLATFORMS, and the reason is the whole
     * shape of turnPersona: publishing through a browser needs a logged-in account, and an UNATTENDED turn that
     * names no persona is denied every account there is. Without this field the publisher could only wake such a
     * turn, one structurally unable to reach the login the post needs, which read from inside the turn as "this
     * account is not connected" and cost two approved posts before anyone traced it back here.
     *
     * A PERSONA RATHER THAN AN ACCOUNT ID, because that is the vocabulary the rest of the system already speaks:
     * `actsAs` is the only pin turnPersona honours, and a card carries the workspace scope the turn also needs to
     * write this file's own status back. Naming the account directly would invent a second way to say the same
     * thing, and the two would disagree the first time a card's accounts changed.
     *
     * The daemon never guesses it. One site can be connected several times over, five Reddit logins here, and
     * picking for the owner means picking wrong in public, with no undo. A draft that needs a turn and names
     * nobody is failed with that sentence instead of sent. */
    actsAs: entryId
        .optional()
        .describe(
            "Whose name it goes out under. Needed for anywhere that requires being logged in, because an unwatched turn naming nobody is allowed no account at all. Never guessed: one site can be connected five times over, and picking for you means picking wrong in public with no undo.",
        ),
    content: z.string().min(1).describe("The post itself."),
    // Reddit posts / YouTube uploads need one.
    title: z.string().optional().describe("A title, where the site wants one."),
    /* Where on the platform: subreddit / Discord channel id / community. OR the URL of the thing this draft
     * replies to. A URL target means the draft is a reply, and on reddit the difference between a thread's
     * address and one comment's permalink is the difference between talking to the room and answering the
     * person: the publisher opens exactly this and replies where it lands. */
    target: z
        .string()
        .optional()
        .describe(
            "Where on the site: a community, a channel. Or the address of the thing this replies to, in which case it is a reply, and on some sites the difference between a thread's address and one comment's is the difference between talking to the room and answering the person.",
        ),
    // Workspace-relative attachment paths, e.g. ".intentic/config/drafts/media/chart.png".
    media: z.array(z.string()).optional().describe("Anything to attach, as workspace paths."),
    // Suggested post time (epoch ms, the at/nextRun convention). Optional, the agent may propose without a
    // date and the owner sets one at approval; an approved draft with no date posts as soon as it's picked up.
    scheduledAt: z
        .number()
        .optional()
        .describe(
            "When it should go out, in milliseconds. An agent may propose without one and you set it when approving; an approved draft with no time goes as soon as it is picked up.",
        ),
    // Agent-written files only need platform + content; status defaults, the rest are optional, so a
    // well-formed proposal never lands in `invalid` just for omitting bookkeeping fields.
    status: DraftStatusSchema.default("proposed").describe(
        "Where it is: proposed by the agent, approved by you, being sent, sent, or failed. Rejecting is deleting it; retrying is approving a failed one again.",
    ),
    createdAt: z.number().optional().describe("When it was written, in milliseconds."),
    // When sending STARTED, stamped with status "posting". The publisher needs it to tell a send that is under
    // way from one whose run died mid-flight, and those two are indistinguishable from the due time, a post
    // scheduled for last week is not a post that has been sending since last week.
    postingAt: z
        .number()
        .optional()
        .describe(
            "When sending started, in milliseconds. Needed to tell a send that is under way from one whose run died mid-flight, which the scheduled time cannot: a post due last week is not a post that has been sending since last week.",
        ),
    postedAt: z.number().optional().describe("When it went out, in milliseconds."),
    // Where it landed, when the platform hands back an address for it. The one thing a posted row can offer
    // that reading the draft cannot: the post itself, to go and look at.
    postedUrl: z
        .string()
        .optional()
        .describe(
            "Where it landed, when the site hands back an address. The one thing a sent draft can offer that reading it cannot: the post itself, to go and look at.",
        ),
    // Why posting failed; set with status "failed". Written for the owner to read in the queue, so it is a
    // sentence rather than a code.
    error: z.string().optional().describe("Why it failed, written as a sentence for a person to read rather than as a code."),
});
export type Draft = z.infer<typeof DraftSchema>;
// The list row / upsert input: the file body plus its filename id.
export const DraftSummarySchema = DraftSchema.extend({ id: entryId.describe("The draft's id.") });
export type DraftSummary = z.infer<typeof DraftSummarySchema>;
// `invalid` = filenames that failed to parse. Agent-written files are a trust boundary, without this a typo'd
// draft would silently never post.
export const DraftsListSchema = z.object({
    drafts: z.array(DraftSummarySchema).describe("The queue."),
    invalid: z
        .array(z.string())
        .describe(
            "Drafts that could not be read at all. Listed rather than skipped, because an agent writes these files directly and a malformed one would otherwise never post and never say why.",
        ),
});
export type DraftsList = z.infer<typeof DraftsListSchema>;
// entryId, not a bare string: the id becomes a filename under .intentic/config/drafts/.
export const DraftIdParamSchema = z.object({ id: entryId.describe("Which draft.") });
