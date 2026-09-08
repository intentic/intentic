import type { CiRunsResponse, PipelineRun } from "@intentic/sandbox-contract";
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

// What CI is doing right now, in the board's own words and split the board's own way: `queued` is never folded into
// `running`, or the rail would claim a runner had picked up work nobody has started. Undefined when nothing is moving,
// which is most of the day.
export const inFlightNote = (all: readonly PipelineRun[]): string | undefined => {
    const running = all.filter((run) => run.status === `running`).length;
    const queued = all.filter((run) => run.status === `queued`).length;
    const parts = [...(running > 0 ? [`${running} running`] : []), ...(queued > 0 ? [`${queued} queued`] : [])];
    return parts.length === 0 ? undefined : parts.join(`, `);
};

// Counts broken branches and says whether anything is in flight; touching `runs` here is what repaints the tile. No
// read marker on the count: it clears only when CI does (a later passing commit), not by opening the view. The two
// readings are deliberately independent — a red branch with its fix already re-running is the ordinary case, and the
// tile says both at once rather than picking the louder one.
export const ciBadge = (): ViewBadge | undefined => {
    const streaks = failureStreaks(runs.value.runs);
    const running = inFlightNote(runs.value.runs);
    if (streaks.length === 0) {
        // Nothing broken: the tile is here only because CI is working, and it stands down when the last run lands.
        return running === undefined ? undefined : { running };
    }
    // The rail's only `danger` tone; everything else there counts work waiting, not something broken.
    return { count: streaks.length, tone: `danger`, tooltip: streakTooltip(streaks), ...(running === undefined ? {} : { running }) };
};
