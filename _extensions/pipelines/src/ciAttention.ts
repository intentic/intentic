import type { CiRunsResponse, PipelineRun, PushChecks } from "@intentic/sandbox-contract";
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { failureStreaks, streakTooltip } from "./ciStreaks";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";
import { t } from "./i18n.js";
import { owedFindings, pushDebtOf } from "./pushChecks";
import { pushChecksQuery } from "./pushChecksQuery";

// Module state owned by activate(), not the view, so the badge updates without Pipelines being open; reads through the
// host's cache, doubling as the board's first paint. A timer, not a file watch: nothing local observes the CI provider,
// so polling every 60s is the whole feed.
const { state: runs, start: startRuns } = sandboxPoll<CiRunsResponse>({
    host,
    everyMs: 60_000,
    initial: () => ({ repos: [], runs: [] }),
    read: async (api) => api.sandbox.fetch(ciRunsQuery()),
});

// What pushes left, on the same beat and through the same cache the section reads. A daemon that serves no push record
// answers nothing here, which leaves the empty record standing: no finding is ever guessed at.
const {
    state: pushes,
    start: startPushes,
    refresh: refreshPushAttention,
} = sandboxPoll<PushChecks>({
    host,
    everyMs: 60_000,
    initial: () => ({ pushed: [], reds: [] }),
    read: async (api) => api.sandbox.fetch(pushChecksQuery()),
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export const startCiAttention = (): Disposable => {
    const polls = [startRuns(), startPushes()];
    return { dispose: () => polls.forEach((poll) => poll.dispose()) };
};

// Called after the owner's own press on a finding, so the tile moves with the section rather than a poll later.
export { refreshPushAttention };

// Whether the hook has measured a push here at all: what stands the tile up in a workspace no forge is connected to, since
// what a push left exists without CI. Read inside the host's detect, so the tile appears with the first push filed.
export const pushesRecorded = (): boolean => pushes.value.pushed.length > 0 || pushes.value.reds.some((red) => red.source === `push`);

// What CI is doing right now, in the board's own words and split the board's own way: `queued` is never folded into
// `running`, or the rail would claim a runner had picked up work nobody has started. Undefined when nothing is moving,
// which is most of the day.
export const inFlightNote = (all: readonly PipelineRun[]): string | undefined => {
    const running = all.filter((run) => run.status === `running`).length;
    const queued = all.filter((run) => run.status === `queued`).length;
    const parts = [...(running > 0 ? [`${running} running`] : []), ...(queued > 0 ? [`${queued} queued`] : [])];
    return parts.length === 0 ? undefined : parts.join(`, `);
};

// THE TILE'S THREE READINGS, kept apart. Broken branches are the count and the rail's only `danger` tone, cleared when
// CI is (a later passing commit), never by opening the view. What pushes left is quieter: a `warning` count of the
// findings still owed, drawn only while nothing is broken, and otherwise a clause in the tooltip, so it never outranks
// a red and never hides one. It clears when a later measurement stops finding them or the owner dismisses them, so the
// owner is always one press from a quiet tile. In flight is the running mark, independent of both: a red branch with
// its fix already re-running is the ordinary case, and the tile says both at once rather than picking the louder one.
export const attentionBadge = (all: readonly PipelineRun[], owed: number): ViewBadge | undefined => {
    const streaks = failureStreaks(all);
    const running = inFlightNote(all);
    const moving = running === undefined ? {} : { running };
    const left = owed > 0 ? t(`rail.leftAtPush`, { count: owed }, owed) : undefined;
    if (streaks.length > 0) {
        const tooltip = [streakTooltip(streaks), ...(left === undefined ? [] : [left])].join(` · `);
        return { count: streaks.length, tone: `danger`, tooltip, ...moving };
    }
    if (left !== undefined) {
        return { count: owed, tone: `warning`, tooltip: left, ...moving };
    }
    // Nothing broken or owed: the tile is here only because CI is working, and it stands down when the last run lands.
    return running === undefined ? undefined : { running };
};

// Touching both polls' state here is what repaints the tile.
export const ciBadge = (): ViewBadge | undefined => attentionBadge(runs.value.runs, owedFindings(pushDebtOf(pushes.value)));
