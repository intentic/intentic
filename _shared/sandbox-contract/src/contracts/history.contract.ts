import { oc } from "@orpc/contract";
import { FileDiffSchema, SnapshotDiffSchema, SnapshotFileDiffQuerySchema, SnapshotIdSchema, SnapshotsListSchema } from "../schemas/history.js";
import { OkSchema } from "../schemas/shared.js";

// Workspace history: daemon-owned snapshots of /work with diff + restore. `diff` compares a checkpoint against
// the previous visible checkpoint (everything that happened since it, hidden interval captures included); an
// unknown id is a handler-thrown NOT_FOUND.
export const historyContract = {
    list: oc
        .route({
            method: "GET",
            path: "/history/snapshots",
            summary: "Points you can go back to",
            description:
                "The saved states of the whole workspace, taken automatically as work happens. This is the timeline behind undoing a change that was never committed.",
        })
        .output(SnapshotsListSchema),
    diff: oc
        .route({
            method: "GET",
            path: "/history/diff",
            summary: "What changed since a saved point",
            description: "The files that differ between one saved point and the one before it, taking in everything that happened in between.",
        })
        .input(SnapshotIdSchema)
        .output(SnapshotDiffSchema),
    fileDiff: oc
        .route({
            method: "GET",
            path: "/history/file-diff",
            summary: "One file's before and after across a saved point",
            description: "Both sides of a single file at one point in the timeline.",
        })
        .input(SnapshotFileDiffQuerySchema)
        .output(FileDiffSchema),
    restore: oc
        .route({
            method: "POST",
            path: "/history/restore",
            summary: "Put the workspace back",
            description:
                "Returns every file to how it stood at a saved point. This restores the files; moving a branch is a different thing and lives with the git calls.",
        })
        .input(SnapshotIdSchema)
        .output(OkSchema),
};
