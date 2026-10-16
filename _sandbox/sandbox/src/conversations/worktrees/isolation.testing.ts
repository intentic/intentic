import { basename } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { sessionsDir } from "../../sessions/session-store.js";
import { type IsolationPlan, overlaysDir, type TurnIsolation } from "./isolation.js";

// Container without CAP_SYS_ADMIN, what the worktree suites use for the symlink-mirroring fallback; planFor still
// answers WHERE the worktree sits since that is a layout fact, not a kernel one. No sandbox either, so a fenced turn
// run through it is refused.
export const noIsolation = (root: string, historyRoot: string = HISTORY_ROOT): TurnIsolation => ({
    available: async () => false,
    sandboxAvailable: async () => false,
    planFor: async (worktree: string, fence: readonly string[] | undefined): Promise<IsolationPlan> => ({
        worktree,
        root,
        mirrors: [],
        overlays: overlaysDir(historyRoot, basename(worktree)),
        fence: fence === undefined ? undefined : { folders: fence, hidden: [], sessions: sessionsDir(historyRoot, basename(worktree)), gitPointers: [] },
    }),
});
