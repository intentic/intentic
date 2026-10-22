import { z } from "zod";

// THE PEOPLE ON A CONVERSATION'S CARD: who answers for it, and who marked it. Their own module so agents.ts, the fleet's
// summary, stays within its size; agents.ts re-exports every name, so importers keep reading them from there.

// One person behind one mark. The instant rides along so the group can be ordered by who was first, which is also the
// order the names read in.
export const ReactorSchema = z.object({
    email: z.string().describe("Who it was, as the sandbox verified them."),
    name: z.string().optional().describe("What to call them, when their sign-in carried a name. Absent leaves the address to stand for them."),
    at: z.number().describe("When they marked it, in milliseconds."),
});
export type Reactor = z.infer<typeof ReactorSchema>;
// The member answerable for a conversation: whose questions its cards are, who a reviewer asks about its work. Derived
// once from the starter, moved only by `agents.assign`; never a program, which is what `startedBy` is for.
export const SessionOwnerSchema = z.object({
    email: z.string().describe("Who answers for this conversation, as the sandbox verified them."),
    name: z
        .string()
        .optional()
        .describe("What to call them, when the sign-in that made them its owner carried a name. Absent leaves the address to stand for them."),
    since: z.number().describe("When they became its owner, in milliseconds."),
});
export type SessionOwner = z.infer<typeof SessionOwnerSchema>;
// Grouped by emoji on the wire, not as a flat list of presses: every surface draws one chip per emoji, and grouping
// here is what stops three of them each grouping it differently.
export const AgentReactionSchema = z.object({
    emoji: z.string().describe("The mark itself, one emoji, carried as the character rather than as a name that would need a table on both sides."),
    by: z
        .array(ReactorSchema)
        .min(1)
        .describe(
            "Everyone wearing this mark, oldest first, each by name. Carried whole rather than as a count, because a chip reading 3 that cannot say whose is a number nobody can answer. Never empty: the last person taking theirs back takes the whole chip with it.",
        ),
});
export type AgentReaction = z.infer<typeof AgentReactionSchema>;
