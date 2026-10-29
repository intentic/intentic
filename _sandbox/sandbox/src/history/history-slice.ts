import { join } from "node:path";
import { workspacePaths } from "../workspace/workspace.js";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { createWorkspaceHistory, type WorkspaceHistory } from "./history.js";

export interface HistorySlice {
    // Daemon-owned workspace snapshots on /history, outside agent reach: captured per turn and on an interval.
    readonly history: WorkspaceHistory & {
        readonly checkpointIn: (dir: string, checkout: string, label: string) => Promise<void>;
    };
}

export const historySlice = defineSlice<HistorySlice>({
    build: ({ config, workspace, logger }: Pick<CompositionCore, "config" | "workspace" | "logger">) => {
        const checkouts = new Map<string, WorkspaceHistory>();
        return {
            history: {
                ...createWorkspaceHistory({ workspace, historyRoot: config.historyRoot, logger }),
                checkpointIn: async (dir, checkout, label) => {
                    const key = JSON.stringify([checkout, dir]);
                    let history = checkouts.get(key);
                    if (history === undefined) {
                        history = createWorkspaceHistory({
                            workspace: workspacePaths(dir),
                            historyRoot: join(config.historyRoot, "checkout-history", encodeURIComponent(checkout), encodeURIComponent(dir)),
                            logger,
                        });
                        checkouts.set(key, history);
                    }
                    await history.snapshot("user", label);
                },
            },
        };
    },
    stop: ({ history }) => history.stop(),
});
