import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract";

// Whether a branch is red right now, judged on its last commit rather than its last run: near-simultaneous workflows
// mean a green one can hide a red one. A state, not a one-time edge: it clears only when a later commit passes, never
// on merely being viewed. One streak per branch, however many commits deep, keeps the count from becoming noise.

export interface FailureStreak {
    readonly repo: string;
    readonly branch: string;
    // The commit at the head of the branch: the one that is broken now.
    readonly sha: string;
    // When the branch WENT red: the oldest failure in the unbroken run of red commits at the head.
    readonly since: number;
    // For the tooltip: commits in a row that are red, and how many runs failed across them.
    readonly commits: number;
    readonly runs: number;
}

// Only failed/success count as verdicts; canceled, skipped and running can't start or break a streak. A commit with no
// verdicted run at all isn't a commit here; the walk skips straight over it.
const isTerminal = (run: PipelineRun): boolean => run.status === `failed` || run.status === `success`;

const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

// A semver-looking tag (v1.2.3, ...): workflow_dispatch runs from a release tag carry the tag as head_branch, not the
// real branch. Excluded from auto-open, or stale release runs bury the board.
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

// Each branch's commits, newest first, ordered by their newest run: the closest proxy to push order this data has
// (commit parentage isn't known).
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
        // Runs back to the last passing commit, or the window's oldest run; never looks newer than it is.
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

// Only the head commit's failures are open: a breakage three commits deep is one demand, not three. Two workflows on
// the same commit are still two: a fix button acts on one run.
export const openFailures = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const open = new Set<PipelineRun>();
    for (const [head] of commitsByBranch(runs)) {
        for (const failure of head?.failed ?? []) {
            // Tag refs (v1.2.3) are release dispatch runs, not the user's current work.
            if (!isTagRef(failure.branch)) {
                open.add(failure);
            }
        }
    }
    return open;
};

// Unfinished runs (queued counts too) on each branch's newest commit. Its own walk, not `commitsByBranch`: that keeps
// only verdicted runs, so an all-still-going push wouldn't have a commit in it at all.
export const inFlightOnHead = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const heads = new Map<string, PipelineRun>();
    for (const run of runs) {
        const key = branchKey(run);
        const head = heads.get(key);
        if (head === undefined || run.createdAt > head.createdAt) {
            heads.set(key, run);
        }
    }
    return new Set(runs.filter((run) => isPipelineInFlight(run.status) && heads.get(branchKey(run))?.sha === run.sha && !isTagRef(run.branch)));
};

// Union, not precedence: a commit can have a live run and a failure worth showing both. Both halves are head-commit
// rules, so a breakage six commits deep still opens one row, not six.
export const arrivesOpen = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => new Set([...inFlightOnHead(runs), ...openFailures(runs)]);

// Earliest later commit that passed clean, not just the newest green; a green on the failure's own commit doesn't
// count. Keyed by run object identity (shared from one query cache); absent means nothing has passed since.
export const supersededBy = (runs: readonly PipelineRun[]): ReadonlyMap<PipelineRun, PipelineRun> => {
    const superseded = new Map<PipelineRun, PipelineRun>();
    for (const commits of commitsByBranch(runs)) {
        // Walking backwards, this always holds the earliest recovery newer than the failure visited.
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

// Names the branch while there's only one breakage; 'main is broken' is actionable, '1' is not. Single-commit says the
// sha; more than one says how deep, which is what changes the response.
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
