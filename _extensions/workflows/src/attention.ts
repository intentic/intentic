import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { host } from "./host";
import { runningOf, workflowRunsQuery } from "./runsQuery";

// Seats the Workflows rail tile only while a run is in flight; it stands down once the last run ends. Said with the
// badge's running mark rather than a count chip: a run in flight is not something waiting on the reader, and a chip is
// the shape the rail keeps for what is. A failed run is not counted here at all (its failed steps already surface on
// the Agents tile). Updated by the daemon's push; `everyMs` only covers a missed frame.
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
    // Phrased to follow the tile's name: "Workflows · 2 running". The count rides the sentence rather than a chip,
    // where it was the one number on the rail nobody could act on.
    return live === 0 ? undefined : { running: `${live} running` };
};
