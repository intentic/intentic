import { z } from "zod";

// A code review's findings in one shape, whichever harness ran the review: Claude Code's `/code-review` reports them
// through its ReportFindings tool, Codex's `review/start` ends on a review item whose comments are read into the same
// rows. The chat draws one card per review (row.review), the same card for either; what the reviewer said around its
// findings is prose on the bubble, never repeated on the card.

// How hard Claude Code's review looked: from a few high-confidence findings (low) to every one it could verify (max).
export const REVIEW_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ReviewLevelSchema = z.enum(REVIEW_LEVELS);
export type ReviewLevel = z.infer<typeof ReviewLevelSchema>;

export const ReviewFindingSchema = z.object({
    file: z.string().describe("The file the finding is in, as the reviewer named it: relative to the checkout, or absolute."),
    line: z.number().int().positive().optional().describe("The 1-based line it anchors to."),
    endLine: z.number().int().positive().optional().describe("The last line of the range it covers, where the reviewer named a range."),
    summary: z.string().describe("The defect in one sentence."),
    title: z.string().optional().describe("The finding as a short label, for a row that has no room for the sentence."),
    scenario: z.string().optional().describe("The concrete inputs or state that lead to the wrong output or the crash."),
    body: z.string().optional().describe("The reviewer's own explanation of the finding, where it wrote one beyond the summary."),
    category: z.string().optional().describe("What kind of finding it is: correctness, simplification, efficiency, and so on."),
    verdict: z.enum(["CONFIRMED", "PLAUSIBLE"]).optional().describe("Whether a verification pass reproduced it, or only found it believable."),
    priority: z.number().int().min(0).max(3).optional().describe("How urgent the reviewer rated it: 0 is the most urgent, as Codex's P0 to P3."),
    outcome: z
        .enum(["fixed", "skipped", "no_change_needed"])
        .optional()
        .describe("What happened to it, on a review re-reported after its fixes were applied."),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewFindingsSchema = z.object({
    id: z.string().min(1).describe("The review's own id: a re-report of the same review (its fixes applied) carries it again and redraws the card."),
    source: z.enum(["claude", "codex"]).describe("Which harness's reviewer reported it."),
    level: ReviewLevelSchema.optional().describe("The effort the review ran at, where the reviewer has levels."),
    findings: z.array(ReviewFindingSchema).describe("What it found, most severe first. Empty when nothing survived."),
    superseded: z.boolean().optional().describe("A later report of this review stands further down the conversation, so this one is drawn folded."),
});
export type ReviewFindings = z.infer<typeof ReviewFindingsSchema>;

// Each reviewer's own cap: ReportFindings takes 32; a Codex review's comments are not capped, so a card says how many
// were left off rather than drawing a hundred rows.
export const REVIEW_FINDINGS_MAX = 50;
// Prose a finding carries is the model's, and unbounded: kept to what a card can draw.
export const REVIEW_TEXT_MAX = 2000;
