import { restoreSnapshot, snapshotDiff, snapshotFileDiff, snapshotList } from "./checkpoints";
import type { Doors } from "../doors";

// The workspace's checkpoints (daemon/checkpoints.ts): the recording's own, and one before every git verb that moves the
// tree; restoring one puts the pending work back as it stood then.
export const historyDoors = {
    list: () => snapshotList(),
    diff: ({ id }) => snapshotDiff(id),
    fileDiff: ({ id, scope, path }) => snapshotFileDiff(id, scope, path),
    restore: ({ id }) => restoreSnapshot(id),
} satisfies Doors<`history`>;
