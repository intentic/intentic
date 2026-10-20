import { z } from "zod";
import { ATTACHMENT_LIMIT, ConversationIdSchema, ForkOfSchema, FreshOfSchema, QueuedServingSchema } from "./agent.js";

// A PERSON'S UNSENT WORDS FOR ONE CONVERSATION, held by the sandbox. Until 2026-10-20 a composer's words lived only in the
// browser: in each window's tab snapshot, moved into a per-browser "closed drafts" set when the tab closed and back out
// when it reopened, and broadcast between windows as previews. Every move was a chance to lose or duplicate them: a
// popped-out chat and the board each held a copy for a round trip, two windows wrote the same chat's words over each
// other, and another device never saw them at all. Now the sandbox holds the one record, per person and conversation, and
// a browser keeps only an optimistic copy of it. A draft never goes by itself (AgentSummary.next never names one), and it
// is not egress: no model reads it until the person sends it, when it becomes the message the privacy shield judges.

// The words as the composer holds them: what the message will say, its files, and who it will go to when it opens a
// conversation (the pick a draft for a conversation the sandbox has never seen has nowhere else to live).
const draftWords = {
    text: z.string().max(200_000).describe("The words, exactly as typed."),
    attachments: z
        .array(z.string().min(1))
        .max(ATTACHMENT_LIMIT)
        .optional()
        .describe("Files staged with it, as workspace paths already uploaded."),
    serves: QueuedServingSchema.optional().describe(
        "Who the message is to go to: the provider, loop, model, effort and account picked in the composer. Absent when nothing was picked.",
    ),
    forkOf: ForkOfSchema.optional().describe("Where the conversation this draft opens is cut from, when it is a fork no turn has started yet."),
    freshOf: FreshOfSchema.optional().describe("The work a fresh session this draft opens starts from, when no turn has started it yet."),
};

export const ComposerDraftSchema = z.object({
    conversationId: ConversationIdSchema.describe("The conversation the words are for. It may not exist yet: a new chat's words are a draft before its first turn."),
    ...draftWords,
    since: z.number().describe("When the composer first held these words unsent, in milliseconds."),
    revision: z
        .number()
        .int()
        .positive()
        .describe("Moves with every write of any of your drafts. A write or a clear naming an older one is answered with the newer draft instead."),
});
export type ComposerDraft = z.infer<typeof ComposerDraftSchema>;

export const ComposerDraftsSchema = z.object({
    drafts: z.array(ComposerDraftSchema).describe("Every draft you hold in this sandbox, newest first. Only your own: another member's unsent words are theirs."),
    revision: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            "The newest revision handed out when this list was read. A draft you hold at a revision past it was written after the read, so its absence here says nothing about it.",
        ),
});
export type ComposerDrafts = z.infer<typeof ComposerDraftsSchema>;

export const DraftWriteSchema = z.object({
    id: ConversationIdSchema.describe("The conversation the words are for."),
    ...draftWords,
    since: z.number().optional().describe("When the words were first held unsent. Leave it out to keep the draft's own, or to start it now."),
    base: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            "The draft's revision these words were edited from. When the draft has been written since (another window, another device), nothing is written and the newer draft comes back with `conflict`, so no one's words are overwritten unseen. Leave it out to write a draft you have never read.",
        ),
});
export type DraftWrite = z.infer<typeof DraftWriteSchema>;

export const DraftWrittenSchema = z.object({
    draft: ComposerDraftSchema.optional().describe("The draft as it now stands. Absent when there is none: it was cleared, or sent, before this write arrived."),
    conflict: z
        .literal(true)
        .optional()
        .describe("Nothing was written: the draft had moved past `base`. Merge your words into this one and write again from its revision."),
});
export type DraftWritten = z.infer<typeof DraftWrittenSchema>;

export const DraftClearSchema = z.object({
    id: ConversationIdSchema.describe("The conversation whose draft to clear."),
    revision: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Clear it only while it is still this revision, so words written since in another window survive. Leave it out to clear whatever is there."),
});
export type DraftClear = z.infer<typeof DraftClearSchema>;
