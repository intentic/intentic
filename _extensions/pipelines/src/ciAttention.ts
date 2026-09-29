import type { CiRunsResponse, PipelineRun } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { failureStreaks, streakTooltip } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";
import { t } from "./i18n.js";

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

// The runs and repositories as the poll last read them: what the run side view's tab and a claimed link are answered
// from, since both are asked synchronously, on a render and on a click.
export const ciRunsNow = (): CiRunsResponse => runs.value;

// What CI is doing right now, in the board's own words and split the board's own way: `queued` is never folded into
// `running`, or the rail would claim a runner had picked up work nobody has started. Undefined when nothing is moving,
// which is most of the day.
export const inFlightNote = (all: readonly PipelineRun[]): string | undefined => {
    const running = all.filter((run) => run.status === `running`).length;
    const queued = all.filter((run) => run.status === `queued`).length;
    const parts = [
        ...(running > 0 ? [t(`extension.running`, { count: running })] : []),
        ...(queued > 0 ? [t(`extension.queued`, { count: queued })] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(`, `);
};

// THE TILE'S TWO READINGS, kept apart. Broken branches are the count and the rail's only `danger` tone, cleared when CI
// is (a later passing commit), never by opening the view. In flight is the running mark, independent of it: a failing
// branch with its fix already re-running is the ordinary case, and the tile says both at once rather than picking the louder one.
export const attentionBadge = (all: readonly PipelineRun[]): ViewBadge | undefined => {
    const streaks = failureStreaks(all);
    const running = inFlightNote(all);
    if (streaks.length === 0) {
        // Nothing broken: the tile is here only because CI is working, and it stands down when the last run lands.
        return running === undefined ? undefined : { running };
    }
    const broken: ViewBadge = { count: streaks.length, tone: `danger`, tooltip: streakTooltip(streaks) };
    return running === undefined ? broken : { ...broken, running };
};

// Touching the poll's state here is what repaints the tile.
export const ciBadge = (): ViewBadge | undefined => attentionBadge(runs.value.runs);
