import { z } from "zod";

// The daemon's state engine as the host reads it, in two documents a Rust binary (`ic`) parses by these field names:
// the update pre-flight's one line (the target image's state-plan.ts, read by _sandbox/ic/src/sandbox/preflight.rs and
// embedded verbatim in the staged-update marker), and the `state` of `/health` (read by _sandbox/ic/src/health.rs). The
// golden files beside the contract (golden/) are this schema's examples, and the Rust tests assert against them.

export const PlanStepSchema = z.object({
    document: z.string().describe("The stored file, workspace-relative, or `<volume>:<path>` for one on another volume; a structural step's id."),
    change: z.string().describe("What is done to it, in one line."),
    detail: z.string().optional().describe("What was particular about this one: a conflict's losing value, a retired entry, a mapped value."),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanFailureSchema = z.object({
    document: z.string().describe("The stored file whose conversion would fail, or the structural step that would."),
    detail: z.string().describe("Why, in the conversion's own words."),
});
export type PlanFailure = z.infer<typeof PlanFailureSchema>;

// The one format `ic` reads; any other is "no plan", never a guess at what its fields mean.
export const STATE_PLAN_FORMAT = 1;

export const StatePlanSchema = z.object({
    plan: z.literal(STATE_PLAN_FORMAT).describe("The format of this line. A reader refuses any other rather than guessing at its fields."),
    version: z.string().describe("The release of the image that planned it; 0.0.0 for a development build."),
    engine: z.number().describe("The conversion count builds before the digest compared. Reported, never decided by."),
    digest: z.string().describe("What identifies the planning build's conversion set: its episodes resume only under the same one."),
    ok: z.boolean().describe("False when a conversion would fail on this sandbox's files, which refuses the update before anything is touched."),
    downgrade: z.boolean().describe("A newer release than the planning build ran here: it opens what it cannot read read-only."),
    failures: z.array(PlanFailureSchema).describe("Each conversion or step that would fail, and why."),
    steps: z.array(PlanStepSchema).describe("What the first boot changes on disk: documents moved, structural steps run."),
    converts: z
        .array(PlanStepSchema)
        .optional()
        .describe("What the build's conversions change as its stores read these files, written by each store's next save. Absent from a build before it."),
    files: z.array(z.string()).describe("Every file the first boot writes, workspace-relative where it can be."),
});
export type StatePlan = z.infer<typeof StatePlanSchema>;

// The `state` of `/health`: whether an update's state changes are still uncommitted. The host rolls an update back when
// the journal stays open, so this rides the same probe as the boot's progress.
export const StateStatusSchema = z.object({
    journal: z.enum(["open", "none"]).describe("Open from the start of a boot that changed stored files until that boot has converged."),
    engine: z.number().describe("The running build's conversion count."),
});
export type StateStatus = z.infer<typeof StateStatusSchema>;
