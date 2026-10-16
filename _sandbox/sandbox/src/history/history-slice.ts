import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history.js";

export interface HistorySlice {
    // Daemon-owned workspace snapshots on /history, outside agent reach: captured per turn and on an interval.
    readonly history: WorkspaceHistory;
}

export const historySlice = defineSlice<HistorySlice>({
    build: ({ config, workspace, logger }: Pick<CompositionCore, "config" | "workspace" | "logger">) => ({
        history: createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
    }),
    stop: ({ history }) => history.stop(),
});
