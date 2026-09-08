import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import { failureStreaks } from "./ciStreaks";

// Row order ranks how loudly a repository is asking, not discovery order:
// 0 failing: a branch's last run is red.
// 1 in flight: running or queued (queued is its own row number, not its own rank).
// 2 warned: `hookWarning` is set; often why a repo looks silent.
// 3 settled: has runs, nothing red or moving.
// 4 silent: no runs at all.
// Ties break by newest run, then name.

export interface RepoStanding {
    readonly repo: CiRepo;
    readonly runs: readonly PipelineRun[];
    // Branches whose last commit is red, not failed runs; multiple failures in one breakage still count as one.
    readonly failing: number;
    readonly running: number;
    // Accepted by the forge, not yet picked up by a runner; kept separate from `running`.
    readonly queued: number;
    // Nothing to show: no runs, and no warning explaining why there are none.
    readonly silent: boolean;
    // The newest run's createdAt; 0 when the repository has never run one.
    readonly latest: number;
}

const rank = (standing: Omit<RepoStanding, `silent`>): number => {
    if (standing.failing > 0) {
        return 0;
    }
    if (standing.running > 0 || standing.queued > 0) {
        return 1;
    }
    if (standing.repo.hookWarning !== undefined) {
        return 2;
    }
    return standing.runs.length > 0 ? 3 : 4;
};

export const repoStandings = (repos: readonly CiRepo[], runs: readonly PipelineRun[]): RepoStanding[] => {
    // Computed once across all repos; scoping per repo first would repeat the same work N times.
    const broken = failureStreaks(runs);
    return repos
        .map((repo) => {
            const mine = runs.filter((run) => run.repo === repo.repo);
            const standing = {
                repo,
                runs: mine,
                failing: broken.filter((streak) => streak.repo === repo.repo).length,
                running: mine.filter((run) => run.status === `running`).length,
                queued: mine.filter((run) => run.status === `queued`).length,
                latest: Math.max(0, ...mine.map((run) => run.createdAt)),
            };
            return { ...standing, silent: rank(standing) === 4 };
        })
        .toSorted((a, b) => rank(a) - rank(b) || b.latest - a.latest || a.repo.repo.localeCompare(b.repo.repo));
};

// Full-state hover text for a row that otherwise shows only a number and a tint; failing branches leads, matching what
// the row itself highlights.
export const standingNote = (standing: RepoStanding): string =>
    [
        standing.runs.length === 0
            ? `No runs yet`
            : standing.failing === 0
              ? `Nothing failing`
              : `${standing.failing} branch${standing.failing === 1 ? `` : `es`} failing`,
        standing.running === 0 ? undefined : `${standing.running} running`,
        standing.queued === 0 ? undefined : `${standing.queued} queued`,
        standing.runs.length === 0 ? undefined : `${standing.runs.length} run${standing.runs.length === 1 ? `` : `s`}`,
        standing.repo.hookWarning === undefined ? undefined : `webhook not registered`,
    ]
        .filter((clause) => clause !== undefined)
        .join(` · `);
