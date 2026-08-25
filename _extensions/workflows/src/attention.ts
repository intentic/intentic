import type { WorkflowRun } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { host } from "./host";
import { runningOf, workflowRunsQuery } from "./runsQuery";

/* WHAT WORKFLOWS HAS TO SAY WHILE NOBODY IS LOOKING AT IT.
 *
 * This was a permanent, silent tile: a designer you open when you want to build a fan-out, holding one of the
 * nine seats a laptop's rail has, on every workspace, forever. The app's seat table (core-views/registry.ts)
 * seats a tile while it is badging, so the question this file answers is the honest one: when does this surface
 * genuinely want to be on the rail?
 *
 * WHILE A RUN IS IN FLIGHT, and only then. A workflow run is a fan-out of agent sessions that takes minutes to
 * hours, started deliberately and then left to work: the tile is the way back to the graph while it moves, and
 * a rail that shows it exactly then is a rail that tracks what this workspace is doing. When the last run ends
 * the tile stands down, which is right, because a finished graph is history and history does not summon anyone.
 *
 * `neutral`, DELIBERATELY. "Two runs are working" is an inventory, not a debt: nothing at the other end of it is
 * waiting for the reader (viewBadge.ts is explicit about the difference), and drawing it in the tone unread
 * agents wear would be this tile asking to be cleared. It is still the whole reason the tile is seated: what
 * seats a tile is having something true and TRANSIENT to say, and the tone is how loudly it says it.
 *
 * WHAT THIS DELIBERATELY DOES NOT COUNT is runs that ENDED BADLY. A failed graph is worth someone's attention,
 * but "unacknowledged" is the only honest form of that claim (ext-pipelines and ext-maintenance both keep a
 * ledger of what the owner has seen), and there is nowhere here to acknowledge one yet. Counting every past
 * failure instead would light the tile permanently the first time a run failed, which is the exact behaviour
 * this whole change removes. The news is not lost meanwhile: a workflow's steps ARE agent conversations, so a
 * run that failed leaves failed cards on the fleet, and the Agents tile carries them.
 *
 * FED BY THE PUSH, not by the interval: the scheduler writes the ledger several times per step and the daemon's
 * watcher batches those into a `workspaceChanged` frame, which wakes this poll (background.ts). `everyMs` is the
 * frame nobody delivered. */
const { state: runs, start: startRunAttention } = sandboxPoll<WorkflowRun[]>({
    host,
    everyMs: 2 * 60_000,
    initial: () => [],
    read: async (api) => api.sandbox.fetch(workflowRunsQuery()),
});

// Started by activate() so the tile is seated from login while a run left going overnight is still working, and
// disposed with the extension.
export { startRunAttention };

// Read inside the host's render computed: touching `runs` here is what repaints, and now also what seats, the
// tile.
export const workflowsBadge = (): ViewBadge | undefined => {
    const live = runningOf(runs.value);
    if (live === 0) {
        return undefined;
    }
    return {
        count: live,
        tone: `neutral`,
        // Phrased to follow the tile's name, which the rail puts in front of it: "Workflows · 2 running".
        tooltip: `${live} running`,
    };
};
