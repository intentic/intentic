import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { host } from "./host";
import { runningOf, workflowRunsQuery } from "./runsQuery";

// Seats the Workflows rail tile only while a run is in flight; it stands down once the last run ends. `neutral` tone
// deliberately: a run count is inventory, not something waiting on the reader, and a failed run is not counted here
// (its failed steps already surface on the Agents tile). Updated by the daemon's push; `everyMs` only covers a missed
// frame.
const { state: runs, start: startRunAttention } = sandboxPoll<WorkflowRun[]>({
    host,
    everyMs: 2 * 60_000,
    initial: () => [],
    read: async (api) => api.sandbox.fetch(workflowRunsQuery()),
});

// Started by activate(), so an overnight run still seats the tile from login; disposed with the extension.
export { startRunAttention };

// Reading `runs` here, inside the host's render computed, is what both repaints and seats the tile.
export const workflowsBadge = (): ViewBadge | undefined => {
    const live = runningOf(runs.value);
    if (live === 0) {
        return undefined;
    }
    return {
        count: live,
        tone: `neutral`,
        // Phrased to follow the tile's name: "Workflows · 2 running".
        tooltip: `${live} running`,
    };
};
