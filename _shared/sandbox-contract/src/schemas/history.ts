// history: daemon-owned workspace snapshots (diff + restore)
import { z } from "zod";
// Daemon snapshots /work into bare git dirs on /history, outside the agent's reach; a snapshot groups one commit per
// scope (root + each nested repo) under a shared id. "interval" captures are a hidden safety net that dissolves into
// the next visible checkpoint's diff.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string().describe("The saved point's id, which is what restoring and diffing take."),
    // Committer time, ms since epoch.
    at: z.number().describe("When it was taken, in milliseconds."),
    trigger: SnapshotTriggerSchema.describe(
        "What caused it. The automatic between-turn captures are a safety net and are not listed; they dissolve into the next visible point's differences.",
    ),
    // Absent for anything but a "turn" snapshot.
    label: z.string().optional().describe("What to call it. For one taken before a turn, that turn's prompt."),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
// Which conversation message a turn answers, so its pre-turn checkpoint can be filed under it. `index` is the
// transcript position the turn began at, and how many messages a rewind to it keeps.
export interface SnapshotTurn {
    readonly conversationId: string;
    readonly index: number;
}
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema).describe("Every point you can go back to, newest first.") });
// Restores the workspace to that turn's checkpoint, drops every message after it, and forgets the provider session so
// the next turn opens fresh.
export const RewindTurnSchema = z.object({
    conversationId: z.string().min(1).describe("Which conversation to rewind."),
    index: z
        .number()
        .int()
        .nonnegative()
        .describe(
            "Which message to go back to, counting from the start. It is also how many messages survive: rewinding to the first keeps none of them and puts the files back to before it ran.",
        ),
});
export const RewindResultSchema = z.object({
    snapshot: z
        .string()
        .optional()
        .describe(
            "The saved point the files were put back to. Absent for a conversation working in its own copy, whose rewind moved a branch rather than the shared timeline.",
        ),
    // What the client removes from its own message bubbles.
    dropped: z.number().int().nonnegative().describe("How many messages were removed."),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;
export const SnapshotIdSchema = z.object({ id: z.string().min(1).describe("Which saved point.") });
export const SnapshotChangeSchema = z.object({
    scope: z.string().describe("Which part of the workspace the path belongs to: the workspace root, or one of the repositories inside it."),
    // Forward slashes.
    path: z.string().describe("The path, relative to that scope."),
    status: z.enum(["added", "modified", "deleted", "type-changed"]).describe("What happened to it."),
});
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export const SnapshotDiffSchema = z.object({
    changes: z.array(SnapshotChangeSchema).describe("Everything that differs between this saved point and the one before it."),
});
export const SnapshotFileDiffQuerySchema = z.object({
    id: z.string().min(1).describe("Which saved point."),
    scope: z.string().min(1).describe("Which part of the workspace the path belongs to."),
    path: z.string().min(1).describe("The file, relative to that scope."),
});
// Unified-diff hunks of the changed regions only, not the whole file. An added/deleted file's patch is the whole file;
// `patch` is absent only when even that could not be made.
export const PartialFileDiffSchema = z.object({
    beforeBytes: z.number().int().nonnegative().optional().describe("How big the before side is, in bytes. Absent when the file did not exist yet."),
    afterBytes: z.number().int().nonnegative().optional().describe("How big the after side is, in bytes. Absent when the file was deleted."),
    patch: z
        .string()
        .optional()
        .describe("The changed regions as unified-diff hunks (`@@` sections only). Absent when the change was too large to render even as a patch."),
    more: z.boolean().optional().describe("There were more changed regions than fit; the patch stops at a region boundary."),
});
export type PartialFileDiff = z.infer<typeof PartialFileDiffSchema>;
// Both sides of a file diff (snapshot vs parent, or worktree vs HEAD); an absent side means added/deleted. Binary is
// flagged, not shipped; oversized arrives as `partial`.
export const FileDiffSchema = z.object({
    before: z.string().optional().describe("The whole file as it was. Absent when it did not exist yet, or when `partial` is set."),
    after: z.string().optional().describe("The whole file as it is now. Absent when it was deleted, or when `partial` is set."),
    binary: z.boolean().optional().describe("The file is not text, so neither side is sent."),
    partial: PartialFileDiffSchema.optional().describe("Set when the file was too large to send whole: what is sent instead of the two sides."),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;
