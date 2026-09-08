import type { CiRunsResponse } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { failureStreaks, streakTooltip } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";

// Module state owned by activate(), not the view, so the badge updates without Pipelines being open; reads through the
// host's cache, doubling as the board's first paint. A timer, not a file watch: nothing local observes the CI provider,
// so polling every 60s is the whole feed.
const { state: runs, start: startCiAttention } = sandboxPoll<CiRunsResponse>({
    host,
    everyMs: 60_000,
    initial: () => ({ repos: [], runs: [] }),
    read: async (api) => api.sandbox.fetch(ciRunsQuery()),
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export { startCiAttention };

// Counts broken branches; touching `runs` here is what repaints the tile. No read marker: it clears only when CI does
// (a later passing commit), not by opening the view.
export const ciBadge = (): ViewBadge | undefined => {
    const streaks = failureStreaks(runs.value.runs);
    if (streaks.length === 0) {
        return undefined;
    }
    // The rail's only `danger` tone; everything else there counts work waiting, not something broken.
    return { count: streaks.length, tone: `danger`, tooltip: streakTooltip(streaks) };
};
