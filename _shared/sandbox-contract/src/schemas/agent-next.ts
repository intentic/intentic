import { z } from "zod";

// WHAT MOVES A CONVERSATION NEXT WITH NOBODY PRESSING ANYTHING: the one answer every surface reads (AgentSummary.next).
// Five mechanisms can carry a conversation on by themselves: a spent allowance's held turn re-run at its reopen or moved
// to another account, a message held for memory sent once memory frees, and messages a person booked for a time or for
// after another conversation lands. Each used to publish its own raw state on the card (a booking flag copied onto the
// stored ending and re-synced every beat, the queue's own shadow, a failure code plus an answer the editor looked up in
// Settings), and each surface rebuilt "does it go by itself" from its own subset: the lane from two of them, the card's
// corner from three, the chat's bar from one more. They disagreed (a memory hold "sends when room" in the corner and
// waited in Attention; a booked resend read as Attention after a restart; a booked message cancelled with an archive
// that never counted it). The daemon now derives this one value from what the conversation holds, every time the card
// is read (conversation-next.ts), and nothing else on the card says whether or when it goes by itself.
export const AgentNextSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("rerun"),
        at: z.number().describe("When the held turn goes again, in milliseconds: its allowance's reopen, or the next pass for a move. Already past means any moment now."),
        onto: z.string().optional().describe("The account the owner's answer to the limit is moving it to. Absent when it goes again where it was refused."),
    }),
    z.object({ kind: z.literal("room") }).describe("A message, or a turn the sandbox kept, held because memory ran short: it goes once memory has stayed free a while."),
    z.object({
        kind: z.literal("send"),
        at: z.number().describe("When the soonest booked message goes, in milliseconds."),
        count: z.number().int().min(1).describe("How many messages are booked to go by themselves."),
    }),
    z.object({
        kind: z.literal("land"),
        after: z.string().describe("The conversation whose landed work the first booked message waits for."),
        count: z.number().int().min(1).describe("How many messages are booked to go by themselves."),
    }),
]);
export type AgentNext = z.infer<typeof AgentNextSchema>;

/** Whether a conversation carries on by itself, with nobody pressing anything: the one reading of `next`. */
export const goesBySelf = (agent: { readonly next?: AgentNext | undefined }): boolean => agent.next !== undefined;
