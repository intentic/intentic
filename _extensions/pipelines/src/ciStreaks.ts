import type { PipelineRun } from "@intentic/sandbox-contract";

/* Failure STREAKS, not failed runs — the difference is the whole design of the rail badge.
 *
 * A count of failed runs is a level, and a level badge is lit whenever the level is high, which on a repo
 * that fails often is always. Measured on a live repo: 75 of the last 100 pipelines failed. A "75" on the rail
 * says nothing a user can act on and trains them to stop looking, which costs the badge its one job.
 *
 * A streak is an EDGE: the branch went red, once, at a moment. It badges when the breakage starts and stays
 * quiet however many further runs fail behind it, because after the first one the user already knows. It
 * clears when the branch goes green — the daemon's `pipeline_fixed` event, seen from the other side.
 *
 * Derived from the runs list rather than the daemon's own conclusions record, deliberately: that record is
 * written only by the webhook receiver, so a sandbox whose hook never registered (the `hookWarning` case)
 * would silently never badge. The runs list is filled by the REST backfill too, so this works either way.
 */

export interface FailureStreak {
    readonly repo: string;
    readonly branch: string;
    // When the branch WENT red: the createdAt of the oldest consecutive failure at the head of its history.
    // This is what gets compared against seenAt, so further failures inside an open streak never re-badge.
    readonly since: number;
    // How many consecutive runs have failed — how bad it has got, for the tooltip.
    readonly runs: number;
}

// Only results count. Canceled and skipped are outcomes, not verdicts (the daemon's webhook receiver draws the
// same line), and a run still going hasn't said anything yet — neither may break a streak or start one, so a
// push that supersedes a running pipeline can't fake a recovery.
const isTerminal = (run: PipelineRun): boolean => run.status === `failed` || run.status === `success`;

const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

export const failureStreaks = (runs: readonly PipelineRun[]): FailureStreak[] => {
    const byBranch = new Map<string, PipelineRun[]>();
    for (const run of runs.filter(isTerminal)) {
        const key = branchKey(run);
        const group = byBranch.get(key);
        if (group === undefined) {
            byBranch.set(key, [run]);
            continue;
        }
        group.push(run);
    }

    const streaks: FailureStreak[] = [];
    for (const group of byBranch.values()) {
        const newestFirst = group.toSorted((a, b) => b.createdAt - a.createdAt);
        const [newest] = newestFirst;
        // Green at the head ⇒ whatever happened behind it is over.
        if (newest === undefined || newest.status !== `failed`) {
            continue;
        }
        // The streak runs from the head down to the most recent green (or to the end of what we can see — a
        // streak older than the run window simply reads as starting at the oldest run we have, which only ever
        // makes it look older, never newer, so it cannot resurrect a badge the user already cleared).
        const firstGreen = newestFirst.findIndex((run) => run.status === `success`);
        const failing = firstGreen === -1 ? newestFirst : newestFirst.slice(0, firstGreen);
        const oldest = failing[failing.length - 1];
        streaks.push({
            repo: newest.repo,
            branch: newest.branch,
            // `oldest` is defined whenever `newest` is — it is at worst the same run.
            since: oldest?.createdAt ?? newest.createdAt,
            runs: failing.length,
        });
    }
    // Newest breakage first: if the rail ever names one branch, it should name the one that just broke.
    return streaks.toSorted((a, b) => b.since - a.since);
};

// A streak the user has not looked at since it began. An ongoing breakage they HAVE seen stays silent, which
// is what keeps the badge meaningful on a repo that is red for days at a time.
export const unseenStreaks = (streaks: readonly FailureStreak[], seenAt: number | undefined): FailureStreak[] =>
    streaks.filter((streak) => streak.since > (seenAt ?? 0));

// What the rail says. Named per branch while there is only one, because "main is broken" is a fact the user
// can act on and "1" is not.
export const streakTooltip = (streaks: readonly FailureStreak[]): string => {
    const [only] = streaks;
    if (streaks.length === 1 && only !== undefined) {
        return `${only.repo} ${only.branch} is failing — ${only.runs} run${only.runs === 1 ? `` : `s`} in a row`;
    }
    return `${streaks.length} branches are failing`;
};
