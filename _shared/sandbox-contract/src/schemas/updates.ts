import { z } from "zod";

// WHAT THE HOST LAST DID ABOUT THIS SANDBOX'S VERSION, in the host's own words. Written by `ic` (the swap, its health
// check and the probation that follows it: _sandbox/ic/src/sandbox/outcome.rs) onto /history as `update-outcome.json`,
// the same volume whichever container runs, so the version that ends up running reads what happened to the other one.
// Advisory: the swap and its undoing are the host's; this is only how the sandbox and its owner hear about them.
export const UpdateOutcomeResultSchema = z.enum(["updated", "kept", "restored", "rolled-back"]);
export type UpdateOutcomeResult = z.infer<typeof UpdateOutcomeResultSchema>;

export const UpdateOutcomeSchema = z.object({
    result: UpdateOutcomeResultSchema.describe(
        "What happened. Updated: the new version passed its first health check and runs, with the previous one kept ready until keepUntil. Kept: that probation ended and the new version stays. Restored: the new version never came up, so the previous container was put back at once. Rolled back: the new version came up and then failed its probation (it kept crashing, never became ready, or lost its tunnel), so the host went back to the previous one by itself.",
    ),
    // What the person or program asked for. A string rather than an enum: a newer ic's verb must not make an older
    // daemon drop the whole outcome.
    verb: z.string().optional().describe("What was asked for: update, rollback, rebuild, dev, reshape, or the probation watch acting on its own."),
    at: z.number().describe("When it happened, in milliseconds."),
    from: z.string().optional().describe("The version (or, when it would not say, the image) that ran before."),
    to: z.string().optional().describe("The version (or image) that was moved onto, or that was tried and given up on."),
    // Plain words for the owner: why a version was given up on. Absent for an update that simply worked.
    reason: z.string().optional().describe("Why the host gave up on the new version, in plain words. Absent when nothing went wrong."),
    // A path on the machine that runs the sandbox, which only means something to a person on that machine.
    log: z.string().optional().describe("Where the host kept the full log of the swap, as a path on the machine that runs the sandbox."),
    keepUntil: z
        .number()
        .optional()
        .describe(
            "Until when the previous version stays parked and ready, in milliseconds. While it does, going back takes seconds and nothing is downloaded or rebuilt; after it, going back uses the pinned image.",
        ),
});
export type UpdateOutcome = z.infer<typeof UpdateOutcomeSchema>;

// A published release that was taken back after it shipped (the release pipeline's rollback-stable.sh marks it on its
// GitHub release). A sandbox running one is told, and offered the way back.
export const WithdrawnReleaseSchema = z.object({
    version: z.string().describe("The withdrawn version, which is the one this sandbox is running."),
    reason: z.string().optional().describe("Why it was withdrawn, as the people who withdrew it put it."),
});
export type WithdrawnRelease = z.infer<typeof WithdrawnReleaseSchema>;

// The owner's "not this one": no update is offered while the newest release is the skipped one. `null` clears it.
export const SkipUpdateInputSchema = z.object({
    version: z
        .string()
        .min(1)
        .nullable()
        .describe("The release to stop offering, or null to offer the newest release again. A newer release than the skipped one is always offered."),
});
export type SkipUpdateInput = z.infer<typeof SkipUpdateInputSchema>;

// One image a sandbox can go back to, as `ic sandbox versions` knows it: the pinned local image and what it says it is.
export const RollbackTargetSchema = z.object({
    image: z.string().describe("The local image a rollback would run, pinned under a tag no other flow writes."),
    version: z.string().optional().describe("What that image says it is. Absent when it would not say."),
});
export type RollbackTarget = z.infer<typeof RollbackTargetSchema>;
