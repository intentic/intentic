// history: daemon-owned workspace snapshots (diff + restore)
import { z } from "zod";
// The daemon snapshots /work into bare git dirs on /history (outside the agent's reach). A "snapshot" groups
// one commit per scope (root + each nested repo) under a shared id. Only checkpoint triggers (turn / user /
// pre-restore / restore) are listed; "interval" captures are a hidden safety net that dissolves into the next
// visible checkpoint's diff.

export const SnapshotTriggerSchema = z.enum(["turn", "interval", "pre-restore", "restore", "user"]);
export type SnapshotTrigger = z.infer<typeof SnapshotTriggerSchema>;
export const SnapshotSchema = z.object({
    id: z.string().describe("The saved point's id, which is what restoring and diffing take."),
    // Committer time, ms since epoch.
    at: z.number().describe("When it was taken, in milliseconds."),
    trigger: SnapshotTriggerSchema.describe(
        "What caused it. The automatic between-turn captures are a safety net and are not listed; they dissolve into the next visible point's differences.",
    ),
    // Human-readable checkpoint label, the turn's prompt for "turn" snapshots; absent otherwise.
    label: z.string().optional().describe("What to call it. For one taken before a turn, that turn's prompt."),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
/* WHICH CONVERSATION MESSAGE A TURN ANSWERS, carried alongside the turn so its pre-turn checkpoint can be
 * filed under it (see the sandbox's agent/turn-anchors.ts). `index` is the transcript position the turn began
 * at, which is also how many messages a rewind to it keeps. */
export interface SnapshotTurn {
    readonly conversationId: string;
    readonly index: number;
}
export const SnapshotsListSchema = z.object({ snapshots: z.array(SnapshotSchema).describe("Every point you can go back to, newest first.") });
/* REWIND, go back to a message and carry on from there. Restores the workspace to that turn's checkpoint,
 * drops every message after it, and forgets the provider session so the next turn opens a fresh one.
 *
 * `index` is the transcript position of the user message being rewound TO, which is also how many messages
 * survive, rewinding to the first message of a conversation keeps none of it and restores the workspace to
 * before it ran. */
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
    /* The checkpoint the workspace was restored to, for the History timeline to select. Absent when the
     * conversation works in a checkout of its own: that rewind moved the conversation's own branch, which the
     * workspace timeline does not carry, there is no row there to select. */
    snapshot: z
        .string()
        .optional()
        .describe(
            "The saved point the files were put back to. Absent for a conversation working in its own copy, whose rewind moved a branch rather than the shared timeline.",
        ),
    // Messages dropped from the transcript, what the client removes from its own bubbles.
    dropped: z.number().int().nonnegative().describe("How many messages were removed."),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;
export const SnapshotIdSchema = z.object({ id: z.string().min(1).describe("Which saved point.") });
export const SnapshotChangeSchema = z.object({
    scope: z.string().describe("Which part of the workspace the path belongs to: the workspace root, or one of the repositories inside it."),
    // Scope-relative path with forward slashes.
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
/* WHAT A FILE TOO BIG TO SEND WHOLE ANSWERS WITH INSTEAD, and why that is not simply "no".
 *
 * Both whole sides of a half-megabyte file are a megabyte of JSON per click, so above the cap they are not
 * sent, which used to be the end of it: the response said "too large" and every review surface printed one
 * sentence over an empty pane. That is the wrong trade, because the thing a reader wants out of a big file is
 * almost never the file: it is the handful of lines that MOVED, and those are small however big the file is.
 *
 * So the daemon diffs it and sends the CHANGED REGIONS as a unified patch, at the same three lines of context
 * a collapsed region keeps elsewhere. A 40 KB patch stands in for a 60 MB pair, and the reader gets the actual
 * review rather than a refusal. `patch` carries the `@@` sections only, the file headers git prints above them
 * name rev-specs no one can apply anyway.
 *
 * An added or deleted file has no counterpart to diff against, so its patch IS the file, one region of pure
 * +/− lines. That is still the right answer: cut to the budget, it is the head of the file, which is the peek
 * the reader came for.
 *
 * `patch` is absent only when there was nothing to make one from: a change too large even to render as a
 * patch, or a git that refused. The sizes are still there, so a surface can at least say how big the thing it
 * is not showing is. */
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
// Both sides of a file diff, a snapshot vs its parent, or a working tree vs HEAD; an absent side means the
// file was added/deleted. Binary content is flagged instead of shipped; oversized content arrives as `partial`.
export const FileDiffSchema = z.object({
    before: z.string().optional().describe("The whole file as it was. Absent when it did not exist yet, or when `partial` is set."),
    after: z.string().optional().describe("The whole file as it is now. Absent when it was deleted, or when `partial` is set."),
    binary: z.boolean().optional().describe("The file is not text, so neither side is sent."),
    partial: PartialFileDiffSchema.optional().describe("Set when the file was too large to send whole: what is sent instead of the two sides."),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;
