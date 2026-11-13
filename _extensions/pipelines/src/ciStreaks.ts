import { isPipelineInFlight, type PipelineRun } from "@intentic/sandbox-contract/schemas/ci";

// Whether a branch is failing right now, judged on its last commit rather than its last run: near-simultaneous
// workflows mean a passing one can hide a failed one. A state, not a one-time edge: it clears only when a later commit passes, never
// on merely being viewed. One streak per branch, however many commits deep, keeps the count from becoming noise.

export interface FailureStreak {
    readonly repo: string;
    readonly branch: string;
    // The commit at the head of the branch: the one that is broken now.
    readonly sha: string;
    // When the branch STARTED failing: the oldest failure in the unbroken run of failed commits at the head.
    readonly since: number;
    // For the tooltip: commits in a row that failed, and how many runs failed across them.
    readonly commits: number;
    readonly runs: number;
}

// Only failed/success count as verdicts; canceled, skipped and running can't start or break a streak. A commit with no
// verdicted run at all isn't a commit here; the walk skips straight over it. Neither is one whose finished runs all
// passed while others on it still run: a quick workflow's pass is not the commit's, and counting it would call main
// recovered (and the failures behind it superseded) while the push's real CI is still deciding. A failure on it stands.
const isTerminal = (run: PipelineRun): boolean => run.status === `failed` || run.status === `success`;

const branchKey = (run: PipelineRun): string => `${run.repo}\n${run.branch}`;

// A semver-looking tag (v1.2.3, ...): workflow_dispatch runs from a release tag carry the tag as head_branch, not the
// real branch. Excluded from auto-open, or stale release runs bury the board, and from the failing branches: a tag never
// gets another commit, so a failure on it never cleared, and the rail said "1" over a release for hours (v1.413.0,
// 2026-11-12). A release's failures are their own reading (releaseFailures).
export const isTagRef = (branch: string): boolean => /^v\d+\.\d+\.\d+/.test(branch);

// One commit's verdict on one branch: what every derivation below walks.
interface BranchCommit {
    readonly sha: string;
    // Its terminal runs, newest first. Never empty.
    readonly runs: readonly PipelineRun[];
    readonly newest: PipelineRun;
    // The failed ones. Empty ⇒ the commit passed.
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
    const undecided = new Set(runs.filter((run) => isPipelineInFlight(run.status)).map((run) => `${branchKey(run)}\n${run.sha}`));
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
                if (commit === undefined || (commit.failed.length === 0 && undecided.has(`${branchKey(commit.newest)}\n${sha}`))) {
                    return [];
                }
                return [commit];
            })
            .toSorted((a, b) => b.newest.createdAt - a.newest.createdAt),
    );
};

export const failureStreaks = (runs: readonly PipelineRun[]): FailureStreak[] => {
    const streaks: FailureStreak[] = [];
    for (const commits of commitsByBranch(runs)) {
        const [head] = commits;
        // A clean commit at the head ⇒ whatever happened behind it is over. A tag is a release, not a branch.
        if (head === undefined || head.failed.length === 0 || isTagRef(head.newest.branch)) {
            continue;
        }
        // Runs back to the last passing commit, or the window's oldest run; never looks newer than it is.
        const clean = commits.findIndex((commit) => commit.failed.length === 0);
        const broken = clean === -1 ? commits : commits.slice(0, clean);
        const failed = broken.flatMap((commit) => [...commit.failed]);
        streaks.push({
            repo: head.newest.repo,
            branch: head.newest.branch,
            sha: head.sha,
            since: Math.min(...failed.map((run) => run.createdAt)),
            commits: broken.length,
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

// A RELEASE'S FAILURES, read per workflow rather than per commit: each release tag is a commit of its own, so nothing
// newer ever lands on it, and what says a release workflow works again is a later release's run of the same workflow
// passing (or the failed run itself re-run to a pass, which keeps its id and so is simply no longer failed).
const workflowKey = (run: PipelineRun): string => `${run.repo}\n${run.workflow ?? ``}`;

// Each workflow's newest finished release run, when it failed: the release failures still open. An older failed one
// behind it is history either way, superseded by a pass (releaseSupersededBy) or by the newer failure.
export const releaseFailures = (runs: readonly PipelineRun[]): ReadonlySet<PipelineRun> => {
    const newest = new Map<string, PipelineRun>();
    for (const run of runs.filter((each) => isTagRef(each.branch) && isTerminal(each))) {
        const held = newest.get(workflowKey(run));
        if (held === undefined || run.createdAt > held.createdAt) {
            newest.set(workflowKey(run), run);
        }
    }
    return new Set([...newest.values()].filter((run) => run.status === `failed`));
};

// Each failed release run with the earliest later release run of its workflow that passed.
const releaseSupersededBy = (runs: readonly PipelineRun[]): Map<PipelineRun, PipelineRun> => {
    const superseded = new Map<PipelineRun, PipelineRun>();
    const releases = runs.filter((run) => isTagRef(run.branch) && isTerminal(run)).toSorted((a, b) => a.createdAt - b.createdAt);
    for (const failure of releases.filter((run) => run.status === `failed`)) {
        const recovery = releases.find(
            (run) => run.status === `success` && run.createdAt > failure.createdAt && workflowKey(run) === workflowKey(failure),
        );
        if (recovery !== undefined) {
            superseded.set(failure, recovery);
        }
    }
    return superseded;
};

// Earliest later commit that passed clean, not just the newest pass; a pass on the failure's own commit doesn't
// count. Keyed by run object identity (shared from one query cache); absent means nothing has passed since.
export const supersededBy = (runs: readonly PipelineRun[]): ReadonlyMap<PipelineRun, PipelineRun> => {
    // A release's runs answer per workflow (releaseSupersededBy); a branch's per commit.
    const superseded = releaseSupersededBy(runs);
    for (const commits of commitsByBranch(runs)) {
        if (commits[0] !== undefined && isTagRef(commits[0].newest.branch)) {
            continue;
        }
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
