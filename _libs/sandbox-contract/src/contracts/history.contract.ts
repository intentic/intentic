import { oc } from "@orpc/contract";
import {
    FileDiffSchema,
    OkSchema,
    SnapshotDiffSchema,
    SnapshotFileDiffQuerySchema,
    SnapshotIdSchema,
    SnapshotResultSchema,
    SnapshotsListSchema,
} from "../schemas.js";

// Workspace history: daemon-owned snapshots of /work with diff + restore. `diff` compares a snapshot against
// its per-scope parents (what that snapshot changed); an unknown id is a handler-thrown NOT_FOUND.
export const historyContract = {
    list: oc.route({ method: "GET", path: "/history/snapshots" }).output(SnapshotsListSchema),
    diff: oc.route({ method: "GET", path: "/history/diff" }).input(SnapshotIdSchema).output(SnapshotDiffSchema),
    fileDiff: oc.route({ method: "GET", path: "/history/file-diff" }).input(SnapshotFileDiffQuerySchema).output(FileDiffSchema),
    snapshot: oc.route({ method: "POST", path: "/history/snapshot" }).output(SnapshotResultSchema),
    restore: oc.route({ method: "POST", path: "/history/restore" }).input(SnapshotIdSchema).output(OkSchema),
};
