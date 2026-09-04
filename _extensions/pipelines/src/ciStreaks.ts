import type { PipelineRun } from "@intentic/sandbox-contract";

/* WHETHER A BRANCH IS RED RIGHT NOW, judged on its LAST COMMIT rather than on its last run.
 *
 * A push fires every workflow the repo has: on this workspace's own main, three. They start within the same
 * second, so which one carries the newest `createdAt` is a coin toss, and reading the branch off the single
 * newest run meant a green `docs` run could sit in front of a failed `test` run from the same push and report
 * the branch as fine. The badge blinked out while main was broken, the failed row lost its primary "Fix with
 * agent", and the repo's standing read "Nothing failing" with a red run on screen. So the unit is the COMMIT:
 * every terminal run for one sha is one verdict, and ANY failure in it makes that commit red.
 *
 * IT IS A STATE, NOT A PIECE OF NEWS. This used to be an edge, it badged when a branch went red and went quiet
 * again once the view had been opened, on the reasoning that after the first look the user already knows. What
 * that actually produced is a rail that says nothing while CI is broken: you glance at Pipelines once, and the
 * only surface that tells you main is still red goes dark until somebody pushes a fresh breakage. The badge
 * now stands for the CONDITION and clears the only way the condition does, a later commit that passes.
 *
 * The anti-spam property that motivated the edge is kept where it belongs, in the SHAPE of the number rather
 * than in a read marker: a streak is one per broken branch, so a breakage three commits deep still says "1",
 * and `openFailures` flags only the head commit's failures, so one breakage is one demand and not six.
 *
 * Derived from the runs list rather than the daemon's own conclusions record, deliberately: that record is
 * written only by the webhook receiver, so a sandbox whose hook never registered (the `hookWarning` case)
 * would silently never badge. The runs list is filled by the REST backfill too, so this works either way. */

export interface FailureStreak {
    readonly repo: string;
    readonly branch: string;
    // The commit at the head of the branch: the one that is broken now.
    readonly sha: string;
    // When the branch WENT red: the oldest failure in the unbroken run of red commits at the head.
    readonly since: number;
    // How bad it has got, for the tooltip: how many commits in a row are red, and how many runs failed across
    // them (one commit can contribute several, which is the whole reason the commit is the unit).
    readonly commits: number;
    readonly runs: number;
}

// Only results count. Canceled and skipped are outcomes, not verdicts (the daemon's webhook receiver draws the
// same line), and a run still going hasn't said anything yet, neither may break a streak or start one, so a
// push that supersedes a running pipeline can't fake a recovery. A commit whose runs are ALL non-verdicts is
// therefore not a commit at all here, and the walk passes straight over it to the last one that spoke.
const isTerminal = (run: PipelineRun): boolean => run.status === `failed` || run.status === `success`;

const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

/* A branch that looks like a semver version tag: v1.2.3, v1.245.0, v0.0.1-alpha, etc. GitHub workflow_dispatch
 * runs triggered from a release tag carry the TAG as head_branch (not the actual branch the tag points at),
 * creating pseudo-branches that should not participate in auto-open logic, a running or failed npm-publish on
 * v1.245.0 is not the user's current work, and opening it buries the board under stale release runs. */
const isTagRef = (branch: string): boolean => /^v\d+\.\d+\.\d+/.test(branch);

// One commit's verdict on one branch: what every derivation below walks.
interface BranchCommit {
    readonly sha: string;
    // Its terminal runs, newest first. Never empty.
    readonly runs: readonly PipelineRun[];
    readonly newest: PipelineRun;
    // The red ones. Empty ⇒ the commit passed.
    readonly failed: readonly PipelineRun[];
}

const commitOf = (sha: string, group: readonly PipelineRun[]): BranchCommit | undefined => {
    const runs = group.toSorted((a, b) => b.createdAt - a.createdAt);
    const [newest] = runs;
    return newest === undefined ? undefined : { sha, runs, newest, failed: runs.filter((run) => run.status === `failed`) };
};

/* Each branch's commits, newest first. Ordered by the newest run in each, which is the closest thing a run list
 * carries to push order: the runs name their commit but nothing here knows which commit is that commit's
 * parent. Two pushes seconds apart can therefore tie, and the same second is also exactly when their verdicts
 * are least likely to disagree. */
const commitsByBranch = (runs: readonly PipelineRun[]): BranchCommit[][] => {
    const byBranch = new Map<string, Map<string, PipelineRun[]>>();
    for (const run of runs.filter(isTerminal)) {
        const key = branchKey(run);
        const commits = byBranch.get(key) ?? new Map<string, PipelineRun[]>();
        byBranch.set(key, commits);
        commits.set(run.sha, [...(commits.get(run.sha) ?? []), run]);
    }
    return [...byBranch.values()].map((commits) =>
        [...commits.entries()]
            .flatMap(([sha, group]) => {
                const commit = commitOf(sha, group);
                return commit === undefined ? [] : [commit];
            })
            .toSorted((a, b) => b.newest.createdAt - a.newest.createdAt),
    );
};

export const failureStreaks = (runs: readonly PipelineRun[]): FailureStreak[] => {
    const streaks: FailureStreak[] = [];
    for (const commits of commitsByBranch(runs)) {
        const [head] = commits;
        // A clean commit at the head ⇒ whatever happened behind it is over.
        if (head === undefined || head.failed.length === 0) {
            continue;
        }
        // The streak runs from the head back to the last commit that passed (or to the end of what we can see:
        // a breakage older than the run window reads as starting at the oldest run we have, which only ever
        // makes it look older, never newer).
        const recovered = commits.findIndex((commit) => commit.failed.length === 0);
        const red = recovered === -1 ? commits : commits.slice(0, recovered);
        const failed = red.flatMap((commit) => [...commit.failed]);
        streaks.push({
            repo: head.newest.repo,
            branch: head.newest.branch,
            sha: head.sha,
            since: Math.min(...failed.map((run) => run.createdAt)),
            commits: red.length,
            runs: failed.length,
        });
    }
    // Newest breakage first: if the rail ever names one branch, it should name the one that just broke.
    return streaks.toSorted((a, b) => b.since - a.since);
};

/* The failures on each red branch's HEAD COMMIT, the open problems that branch has. Deliberately not "every
 * failed run with nothing green after it": inside a three-commit breakage all of them are unfixed, but the
 * thing to fix is what the branch's current code does, and a view that flags all of them turns one breakage
 * into six identical demands. Two failed workflows on the SAME commit are two of them, because they are two
 * pipelines with two logs, and the fix button acts on a run.
 *
 * THESE ROWS ALSO ARRIVE EXPANDED, half of `arrivesOpen` below, where the reasoning for that lives. */
export const openFailures = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const open = new Set<PipelineRun>();
    for (const [head] of commitsByBranch(runs)) {
        for (const failure of head?.failed ?? []) {
            // Tag refs (v1.2.3) are release dispatch runs, not the user's current work: see isTagRef.
            if (!isTagRef(failure.branch)) {
                open.add(failure);
            }
        }
    }
    return open;
};

/* WHAT IS IN FLIGHT ON THE CODE AS IT STANDS: the still-running runs on the newest commit each branch has.
 *
 * Half of what the board opens for you (`arrivesOpen` below); `openFailures` above is the other half. A run that
 * is still going has a job graph worth the vertical space unasked, it is the answer arriving, and somebody who
 * came to watch it should not have to click for it. The freshness half is what keeps that from becoming noise: a
 * re-run somebody started on last week's commit is "running" too, and its diagram is not what anyone opened the
 * board for.
 *
 * DELIBERATELY NOT `commitsByBranch` ABOVE, which is why this is a second walk rather than another reader of
 * that one. That walk keeps only the runs that reached a VERDICT, which is right for judging a branch and wrong
 * here: a push whose pipelines are all still going has no terminal run at all, so its commit would not be in
 * that list, and the head would be the commit BEFORE it, exactly at the moment this has to fire.
 *
 * So the head is read off every run, by the newest `createdAt` on the branch, the same push-order proxy the walk
 * above settles for and with the same limit: a re-run of an older commit carries a newer timestamp than the
 * commit that followed it, so it reads as that branch's head. That run is the one somebody just pressed Re-run
 * on, so opening its graph is the right answer either way.
 *
 * Per BRANCH, not one commit for the whole board: two branches building at once are two answers arriving, and a
 * board that opened only the later push would hide a live run for no reason a reader could see. */
export const runningOnHead = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const heads = new Map<string, PipelineRun>();
    for (const run of runs) {
        const key = branchKey(run);
        const head = heads.get(key);
        if (head === undefined || run.createdAt > head.createdAt) {
            heads.set(key, run);
        }
    }
    return new Set(runs.filter((run) => run.status === `running` && heads.get(branchKey(run))?.sha === run.sha && !isTagRef(run.branch)));
};

/* WHAT THE BOARD OPENS FOR YOU (PipelineRunRow's `autoOpen`): everything the newest commit on a branch has to
 * say that is not "fine". The runs still going on it, and the failures it left open.
 *
 * The two are ONE event either side of its ending. A live run's graph is on screen because the answer is
 * arriving; when the answer turns out to be red, that same graph is WHICH JOB BROKE, which is the question
 * anybody looking at a failed row is here to answer, and the evidence the "Fix with agent" button beside it acts
 * on. A board that drew the diagram while the pipeline ran and hid it the moment it failed would be closing at
 * the one moment there was something to read, and would leave a reader who arrived after the run finished, which
 * is most of them, clicking to find out what a red row is red about.
 *
 * BOTH HALVES ARE HEAD-COMMIT RULES, and that is what stops this unrolling the whole list. A re-run somebody
 * left going on last week's code is not opened, a failure behind a newer one is not opened, a failure a later
 * commit closed is not opened, and a breakage six commits deep opens ONE row on that branch rather than six, the
 * same shape that keeps `openFailures` to one demand per breakage.
 *
 * A UNION AND NOT A PRECEDENCE: a commit whose first workflow has already failed while its second is still
 * running is two rows worth opening, and picking one of them would hide either the breakage or the run that
 * might add to it. Note the two halves read `head` differently on purpose, off every run here and off the runs
 * with a verdict there, so a push that is still building shows its live graph AND the failure the last commit
 * left open, which is the branch's most recent word until this push has one of its own. */
export const arrivesOpen = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => new Set([...runningOnHead(runs), ...openFailures(runs)]);

/* For each failed run, the run that put its branch back to green, the EARLIEST one on a LATER COMMIT that
 * passed clean, which is the one that actually recovered the branch rather than whichever green happens to be
 * newest. A green run beside it on its OWN commit closes nothing: that is a different workflow passing on the
 * same broken code, which is precisely the confusion the head-commit rule above exists to end.
 *
 * Keyed by the run object, not by an id: a run's identity across vendors takes host+project+runId to spell, and
 * every caller already holds the very objects this walked. They come from one query cache, so the row rendering
 * a run and the map built from the same list hold the same instance.
 *
 * Absent from the map ⇒ nothing has passed since, so the failure is still the branch's last word. */
export const supersededBy = (runs: readonly PipelineRun[]): ReadonlyMap<PipelineRun, PipelineRun> => {
    const superseded = new Map<PipelineRun, PipelineRun>();
    for (const commits of commitsByBranch(runs)) {
        // Walking backwards in time, every clean commit we meet is earlier than the last one we saw, so this
        // always holds the earliest recovery newer than the failure being visited.
        let recovery: PipelineRun | undefined;
        for (const commit of commits) {
            if (commit.failed.length === 0) {
                recovery = commit.newest;
                continue;
            }
            if (recovery !== undefined) {
                for (const failure of commit.failed) {
                    superseded.set(failure, recovery);
                }
            }
        }
    }
    return superseded;
};

// What the rail says. Named per branch while there is only one, because "main is broken" is a fact the user
// can act on and "1" is not. One commit is the ordinary case and names the commit; more than one says how long
// it has been going, which is the part that changes what you do about it.
export const streakTooltip = (streaks: readonly FailureStreak[]): string => {
    const [only] = streaks;
    if (streaks.length === 1 && only !== undefined) {
        const red = `${only.runs} failed run${only.runs === 1 ? `` : `s`}`;
        return only.commits === 1
            ? `${only.repo} ${only.branch} is failing: ${red} on ${only.sha.slice(0, 7)}`
            : `${only.repo} ${only.branch} is failing: ${only.commits} commits in a row, ${red}`;
    }
    return `${streaks.length} branches are failing`;
};
