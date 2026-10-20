import { z } from "zod";

// Words put in an agent's mouth (`agents.place`): what is asked, and what the record answers.

// Bounded just above the handoff's per-message render cap, so a line too long to carry whole doesn't reach the agent
// truncated.
export const AgentPlaceSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    text: z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .describe(
            "The words to put in the agent's mouth. Bounded just above what the next turn can carry whole, because a line too long to be handed over intact would reach the agent truncated and quietly break the very thing this is for.",
        ),
});
// The placed line's own id, so the window that placed it holds the same row its next read of the record brings.
export const AgentPlacedSchema = z.object({
    ok: z.literal(true).describe("Always true: the line is on the record."),
    rowId: z.string().optional().describe("The `rowId` the line was recorded under. Absent from a sandbox older than row ids."),
});
