import type { PipelineRun } from "@intentic/sandbox-contract";

/* Failure STREAKS, not failed runs, the difference is the whole design of the rail badge.
 *
 * A count of failed runs is a level, and a level badge is lit whenever the level is high, which on a repo
 * that fails often is always. Measured on a live repo: 75 of the last 100 pipelines failed. A "75" on the rail
 * says nothing a user can act on and trains them to stop looking, which costs the badge its one job.
 *
 * A streak is an EDGE: the branch went red, once, at a moment. It badges when the breakage starts and stays
 * quiet however many further runs fail behind it, because after the first one the user already knows. It
 * clears when the branch goes green, the daemon's `pipeline_fixed` event, seen from the other side.
 *
 * Derived from the runs list rather than the daemon's own conclusions record, deliberately: that record is
 * written only by the webhook receiver, so a sandbox whose hook never registered (the `hookWarning` case)
 * would silently never badge. The runs list is filled by the REST backfill too, so this works either way.
 *
 * `openFailures` and `supersededBy` apply the same edge-not-level rule to the ROWS, which are otherwise a
 * chronological log where every failure ever recorded looks equally unfixed. One asks which red row is still a
 * branch's last word, the other which green closed the rest, together they decide how loudly a row may ask.
 */

export interface FailureStreak {
    readonly repo: string;
    readonly branch: string;
    // When the branch WENT red: the createdAt of the oldest consecutive failure at the head of its history.
    // This is what gets compared against seenAt, so further failures inside an open streak never re-badge.
    readonly since: number;
    // How many consecutive runs have failed, how bad it has got, for the tooltip.
    readonly runs: number;
}

// Only results count. Canceled and skipped are outcomes, not verdicts (the daemon's webhook receiver draws the
// same line), and a run still going hasn't said anything yet, neither may break a streak or start one, so a
// push that supersedes a running pipeline can't fake a recovery.
const isTerminal = (run: PipelineRun): boolean => run.status === `failed` || run.status === `success`;

const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

// The verdicts on one branch, newest first, the shape every derivation below walks.
const terminalByBranch = (runs: readonly PipelineRun[]): PipelineRun[][] => {
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
    return [...byBranch.values()].map((group) => group.toSorted((a, b) => b.createdAt - a.createdAt));
};

export const failureStreaks = (runs: readonly PipelineRun[]): FailureStreak[] => {
    const streaks: FailureStreak[] = [];
    for (const newestFirst of terminalByBranch(runs)) {
        const [newest] = newestFirst;
        // Green at the head ⇒ whatever happened behind it is over.
        if (newest === undefined || newest.status !== `failed`) {
            continue;
        }
        // The streak runs from the head down to the most recent green (or to the end of what we can see, a
        // streak older than the run window simply reads as starting at the oldest run we have, which only ever
        // makes it look older, never newer, so it cannot resurrect a badge the user already cleared).
        const firstGreen = newestFirst.findIndex((run) => run.status === `success`);
        const failing = firstGreen === -1 ? newestFirst : newestFirst.slice(0, firstGreen);
        const oldest = failing[failing.length - 1];
        streaks.push({
            repo: newest.repo,
            branch: newest.branch,
            // `oldest` is defined whenever `newest` is, it is at worst the same run.
            since: oldest?.createdAt ?? newest.createdAt,
            runs: failing.length,
        });
    }
    // Newest breakage first: if the rail ever names one branch, it should name the one that just broke.
    return streaks.toSorted((a, b) => b.since - a.since);
};

/* The failure at the head of each red branch, the ONE open problem that branch has. Deliberately not "every
 * failed run with nothing green after it": inside a three-run breakage all three are unfixed, but there is
 * still only one thing to fix, and a view that flags all three is the level-badge mistake in another costume. */
export const openFailures = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const open = new Set<PipelineRun>();
    for (const [newest] of terminalByBranch(runs)) {
        if (newest?.status === `failed`) {
            open.add(newest);
        }
    }
    return open;
};

/* For each failed run, the run that put its branch back to green, the EARLIEST success after it, which is the
 * one that actually recovered the branch rather than whichever green happens to be newest.
 *
 * Keyed by the run object, not by an id: a run's identity across vendors takes host+project+runId to spell, and
 * every caller already holds the very objects this walked. They come from one query cache, so the row rendering
 * a run and the map built from the same list hold the same instance.
 *
 * Absent from the map ⇒ nothing has passed since, so the failure is still the branch's last word. */
export const supersededBy = (runs: readonly PipelineRun[]): ReadonlyMap<PipelineRun, PipelineRun> => {
    const superseded = new Map<PipelineRun, PipelineRun>();
    for (const newestFirst of terminalByBranch(runs)) {
        // Walking backwards in time, every success we meet is earlier than the last one we saw, so this always
        // holds the earliest success newer than the run being visited.
        let recovery: PipelineRun | undefined;
        for (const run of newestFirst) {
            if (run.status === `success`) {
                recovery = run;
                continue;
            }
            if (recovery !== undefined) {
                superseded.set(run, recovery);
            }
        }
    }
    return superseded;
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
        return `${only.repo} ${only.branch} is failing, ${only.runs} run${only.runs === 1 ? `` : `s`} in a row`;
    }
    return `${streaks.length} branches are failing`;
};
