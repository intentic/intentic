import { z } from "zod";

// WHAT HAS LOOKED AT A CONVERSATION'S WORK, as its card says it: what its last turn checked of its own work, and the
// latest code review it reported. Both written by a turn's settle from what the turn did, never asked of the model.
// Re-exported by agents.ts, whose summary carries them.

// What the last turn showed of its own work, read off its tool calls and never asked of the model: the record a card
// badges instead of sending the turn back to prove anything. CI checks what the owner pushes (schemas/ci.ts).
export const TurnProofSchema = z.object({
    at: z.number().describe("When the turn that left this ended, in milliseconds."),
    verification: z
        .enum(["verified", "unproven", "failing", "no-code"])
        .describe(
            "Verified: a check it ran passed after its last edit to code. Failing: the last one it ran failed. Unproven: it changed code and ran nothing that checked it. No-code: it changed nothing a check could speak to.",
        ),
    check: z.string().optional().describe("The command that spoke, when one did, so a targeted test is never read as the whole suite."),
    unviewed: z
        .number()
        .optional()
        .describe("How many rendered files it changed (pages, components, styles) without looking at the result afterwards. Absent when none."),
});
export type TurnProof = z.infer<typeof TurnProofSchema>;
// The latest code review a conversation reported (events/review.ts), counted rather than carried: the findings stay in
// its chat, where the card that sends them to be fixed draws them. Kept until a later review replaces it, since a turn
// that reviews nothing has not undone the one before.
export const ReviewTallySchema = z.object({
    at: z.number().describe("When the turn that reported it ended, in milliseconds."),
    source: z.enum(["claude", "codex"]).describe("Which harness's reviewer reported it."),
    findings: z.number().int().nonnegative().describe("How many findings it reported."),
    open: z
        .number()
        .int()
        .nonnegative()
        .describe("How many of those no re-report has marked fixed or set aside yet. Equal to `findings` until the review is reported again with its fixes applied."),
});
export type ReviewTally = z.infer<typeof ReviewTallySchema>;
