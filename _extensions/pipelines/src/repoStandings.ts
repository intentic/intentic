import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import { failureStreaks } from "./ciStreaks";

/* WHICH REPOSITORY THE BOARD LEADS WITH, and which ones stop costing a card.
 *
 * The repo list arrives in the daemon's discovery order, which is alphabetical by workspace path and has nothing
 * to do with CI. On a real workspace that put four repositories which have never run a pipeline above the one
 * that runs them all day: the entire first screen of a monitoring board was four identical "No runs yet" cards,
 * and the failing run, the only thing anyone opens this page for, sat below the fold.
 *
 * So the order is HOW LOUDLY A REPOSITORY IS ASKING, and one asking nothing at all is not a card:
 *
 *   0 failing   a branch's last word is red, the one thing on this page that wants a person
 *   1 in flight something is running or waiting for a runner, so the answer is arriving
 *   2 warned    the webhook could not be registered (`hookWarning`). Nothing is red, but the board may be out of
 *               date, and this is also the usual reason a repository looks silent, so it outranks green.
 *   3 settled   has runs, nothing red, nothing moving
 *   4 silent    no runs and nothing to say. A rail row rather than a section, see PipelinesView.
 *
 * QUEUED SHARES THE IN-FLIGHT TIER but is counted apart from running, and the two decisions pull in opposite
 * directions on purpose. For ORDER a queued pipeline is unfinished business and belongs above a settled repo,
 * whether or not a runner has picked it up yet. For the WORDS on the row it is the more useful of the two facts:
 * "6 queued" on a repository that has been quiet for an hour is the sentence that sends someone to look at their
 * runners, and "6 running" is the sentence that tells them to wait.
 *
 * Ties break on the newest run, so within a tier the board reads as a feed. Two silent repositories have no runs
 * to compare and fall back to their names, which is the alphabetical order the page used to have throughout. */

export interface RepoStanding {
    readonly repo: CiRepo;
    readonly runs: readonly PipelineRun[];
    // Branches whose last commit is red, NOT failed runs (ciStreaks.ts). Three failures inside one breakage
    // are one thing to fix, and so are two workflows failing on the same commit: the rail says "1".
    readonly failing: number;
    readonly running: number;
    // Accepted by the forge, not yet picked up by a runner. Its own number rather than part of `running`: see
    // the note above on why the row says which of the two it is.
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
    // Across every repository, once: a streak is decided per branch, so scoping this to one repo first would
    // give the same answer at N times the cost.
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

/* What one repository's row says on hover, the full state, because the row itself shows a single number and a
 * tint. Failing branches first, since that is the number the row is showing and the tooltip has to name it. */
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
