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
    download: z
        .boolean()
        .optional()
        .describe("The local pin is gone (pruned outside ic); going back downloads the published image of `version`."),
});
export type RollbackTarget = z.infer<typeof RollbackTargetSchema>;

// UPDATING BY ITSELF. Everything an update costs nobody is done unasked: the machine downloads and builds the next
// release in the background (`ic sandbox prepare --auto`) and checks its state conversions against this sandbox's files.
// What is left is a restart of about half a minute, and THAT is what this decides the moment of: the daemon holds a staged
// update until nothing it can see would feel the restart (no agent mid-turn, nobody at the editor, terminals quiet,
// nothing due), says so to anyone still connected, and then hands the machine the same `update` the button sends, asking
// the next boot to pick up any turn the restart cut. Only a STAGED update is taken this way: one that still has to be
// downloaded is minutes of downtime, which stays a person's decision. `system/updates/auto-update.ts` in the daemon.

// One thing keeping an update waiting. `kind` is a string rather than an enum, as UpdateOutcome's `verb` is: a newer
// daemon's reason must not make an older page drop the whole answer. The ones this build names:
// - agents: an agent is mid-turn, or a subagent, a workflow or a land is still running (`names` says which).
// - people: somebody has the editor on screen and is using it (`names` says who).
// - terminal: a terminal printed something in the last few minutes, the trace of a person or a build still at work.
// - schedule: an automation or a scheduled message is due within minutes, and the restart would land on it (`until`).
// - paused: the owner asked for no automatic update until `until`.
// - machine: the machine that runs this sandbox is not connected, so nothing here can ask it to restart anything.
// - retry: the last try did not take; it is tried again at `until`.
// - consent: the release changes something developers build on (its breaking notes), so it waits for a person to take
//   it, however quiet the sandbox is. Never lifts by itself.
export const AutoUpdateHoldSchema = z.object({
    kind: z
        .string()
        .describe(
            "What it waits on: agents (an agent is mid-turn, or a subagent, workflow or land is running), people (somebody is using the editor), terminal (a terminal was busy in the last few minutes), schedule (an automation or a scheduled message is due shortly), paused (the owner asked it to wait), machine (the machine that runs this sandbox is not connected), retry (the last try did not take), or consent (the release changes something developers build on, so a person takes it). A newer sandbox may name others.",
        ),
    names: z.array(z.string()).optional().describe("Who or what, by name: the agents still working, the people at the editor. Absent when there is nobody to name."),
    until: z
        .number()
        .optional()
        .describe("When this lifts by itself, in milliseconds, for a hold with a moment of its own: a pause, a retry, an automation's next run."),
});
export type AutoUpdateHold = z.infer<typeof AutoUpdateHoldSchema>;

export const AutoUpdateSchema = z.object({
    enabled: z.boolean().describe("Whether this sandbox takes downloaded updates by itself. On unless the owner turned it off."),
    // A string for the same reason as a hold's kind.
    phase: z
        .string()
        .describe(
            "Where it stands: idle (nothing downloaded to take, or turned off), waiting (an update is downloaded and waits for the holds to clear), countdown (it restarts at startsAt unless somebody stops it), or updating (the machine is restarting this sandbox onto it now).",
        ),
    version: z.string().optional().describe("The downloaded version it will take. Absent while idle, or when the download did not say."),
    holds: z.array(AutoUpdateHoldSchema).describe("Everything keeping it waiting right now, the one most likely to last first. Empty unless waiting."),
    startsAt: z.number().optional().describe("During a countdown, when the restart begins, in milliseconds."),
    pausedUntil: z.number().optional().describe("The owner's pause: no automatic update before this moment, in milliseconds. Absent when not paused."),
    failure: z.string().optional().describe("Why the last automatic try did not take, in the machine's own words, while that is still the news."),
    // The update this daemon itself started, read back by the version it moved onto: what lets the card say the
    // restart happened by itself, while nobody was looking.
    lastApplied: z
        .object({ at: z.number(), to: z.string().optional() })
        .optional()
        .describe("The last update this sandbox took by itself: when it began and which version it moved onto."),
});
export type AutoUpdate = z.infer<typeof AutoUpdateSchema>;

// The owner's say over it. Every field is optional and only what is named changes: the switch, a pause (null lifts it),
// or "now", which skips the wait and the countdown for the update already downloaded.
export const AutoUpdateInputSchema = z.object({
    enabled: z.boolean().optional().describe("Turn taking downloaded updates by itself on or off."),
    pausedUntil: z
        .number()
        .nullable()
        .optional()
        .describe("Hold automatic updates until this moment, in milliseconds; null lifts a pause. A moment already past lifts it too."),
    applyNow: z
        .literal(true)
        .optional()
        .describe("Take the downloaded update now, without waiting for a quiet moment or counting down. Refused when nothing is downloaded."),
});
export type AutoUpdateInput = z.infer<typeof AutoUpdateInputSchema>;
