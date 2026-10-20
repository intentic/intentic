import { z } from "zod";

// What one side did to a conflicted path. The first three are Mutagen's own change kinds. `untracked` is its word for
// content it SCANS but never carries — whatever sits under an ignore pattern, which for a workspace means build output
// — and it is the whole difference between a conflict somebody must settle and one a device can clear by itself. Absent
// means Mutagen did not say, not that a side is untouched.
export const DeviceConflictChangeSchema = z.enum(["created", "modified", "deleted", "untracked"]);
export type DeviceConflictChange = z.infer<typeof DeviceConflictChangeSchema>;

// Which of two unlike things this conflict is. `both-edited` is the one the mode exists for: two real copies, one
// choice, a person's. `derived-leftover` is not a disagreement at all — one side deleted a directory, the other still
// holds build output inside it, and Mutagen will not delete a directory whose contents it never carried. Nothing at
// stake, nobody's edit, and no judgement to make.
export const DeviceConflictNatureSchema = z.enum(["derived-leftover", "both-edited"]);
export type DeviceConflictNature = z.infer<typeof DeviceConflictNatureSchema>;

export const DeviceConflictSchema = z.object({
    /** Relative to the synced folder (matches both `localDir` and /work); empty means the root itself. */
    path: z.string(),
    /** What happened on the device (Mutagen's alpha). */
    local: DeviceConflictChangeSchema.optional(),
    /** And in the sandbox's /work (its beta). */
    sandbox: DeviceConflictChangeSchema.optional(),
    // Absent from an agent older than the classification, which is why no reader may treat absence as `both-edited`:
    // `clearableOnDevice` below tests for the derived shape rather than against the other one.
    nature: DeviceConflictNatureSchema.optional(),
});
export type DeviceConflict = z.infer<typeof DeviceConflictSchema>;

// Whether this one is the device's own to clear: build output on the device, inside a directory the sandbox deleted.
// The rule lives here because two sides read it — the machine agent deciding what to remove, and the browser deciding
// whether to offer a button instead of an agent — and they must never disagree about which conflicts need a person.
export const clearableOnDevice = (conflict: DeviceConflict): boolean =>
    conflict.nature === "derived-leftover" && conflict.local === "untracked" && conflict.sandbox === "deleted";

// WHY A FOLDER'S FILE SYNC IS HELD STILL, AND BY WHOM (2026-10-20). The machine agent reads each off a fact it keeps
// on the pairing and makes Mutagen agree every pass (its sync/holds.ts), so a pause never outlives its reason and a
// resume never undoes somebody else's. `owner` is a person's Pause, the only one a person lifts; every other is the
// agent's own and lifts by itself once its reason ends. Strings on the wire, so a reason a newer agent adds still
// reads as held to an older page.
export const DeviceSyncHoldSchema = z.enum(["owner", "gone", "container-missing", "container-trashed", "swap", "unreachable", "low-disk"]);
export type DeviceSyncHold = z.infer<typeof DeviceSyncHoldSchema>;

// The drive reading that paused a pairing for want of room: when (epoch ms), and how much was free of how much.
export const DeviceLowDiskSchema = z.object({
    since: z.number(),
    freeBytes: z.number().nonnegative(),
    totalBytes: z.number().nonnegative(),
});
export type DeviceLowDisk = z.infer<typeof DeviceLowDiskSchema>;

// Why the device stopped fetching a repo's history: git went quiet mid-fetch, the fetch was still running at its
// ceiling, the sandbox's copy is a shallow clone the device's full history cannot take, or git refused for another reason.
// A word an older reader does not know is shown as the plain failure.
export const DeviceBridgeHoldReasonSchema = z.enum(["stalled", "too-long", "shallow", "failed"]);
export type DeviceBridgeHoldReason = z.infer<typeof DeviceBridgeHoldReasonSchema>;

export const DeviceBridgeHoldSchema = z.object({
    repo: z.string(),
    reason: DeviceBridgeHoldReasonSchema.catch("failed"),
    // Fetches in a row that did not finish.
    failures: z.number().int().positive(),
    // When the first of them ended, and when the next may start (epoch ms).
    since: z.number(),
    retryAt: z.number(),
});
export type DeviceBridgeHold = z.infer<typeof DeviceBridgeHoldSchema>;
