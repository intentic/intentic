import { oc } from "@orpc/contract";
import {
    FileDiffSchema,
    OkSchema,
    SnapshotDiffSchema,
    SnapshotFileDiffQuerySchema,
    SnapshotIdSchema,
    SnapshotsListSchema,
} from "../schemas.js";

// Workspace history: daemon-owned snapshots of /work with diff + restore. `diff` compares a checkpoint against
// the previous visible checkpoint (everything that happened since it, hidden interval captures included); an
// unknown id is a handler-thrown NOT_FOUND.
export const historyContract = {
    list: oc.route({ method: "GET", path: "/history/snapshots" }).output(SnapshotsListSchema),
    diff: oc.route({ method: "GET", path: "/history/diff" }).input(SnapshotIdSchema).output(SnapshotDiffSchema),
    fileDiff: oc.route({ method: "GET", path: "/history/file-diff" }).input(SnapshotFileDiffQuerySchema).output(FileDiffSchema),
    restore: oc.route({ method: "POST", path: "/history/restore" }).input(SnapshotIdSchema).output(OkSchema),
};
