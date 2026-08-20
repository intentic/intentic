import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";

/* WHICH ROWS OF A REVIEW ARE WORTH READING AHEAD, AND IN WHAT ORDER.
 *
 * A LEAF, a pure projection over the change list, no store, no query, no Vue, for the same reason agentStatus
 * is one: the source that builds the wishes, the panel that draws the rows, and the test that pins the order can
 * all reach the same answer without any of them dragging in the app shell. */

// The panel's own reading order: conflicts first (they block the commit), then staged, then unstaged, repo by
// repo. Reading ahead in a different order than the list is drawn in would warm the rows the reader reaches last.
const SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

/* How far down the list one pass reads. GENEROUS, because a row's ± depends on it.
 *
 * This used to be 30, on the reasoning that reading further spent daemon time on files nobody would open. That was
 * true while the only thing at stake was a click's latency. It stopped being true when the counts beside the rows
 * became the code's rather than git's (useCodeStats): the count is a by-product of reading the file, so a row this
 * cap left out was a row whose number could not be worked out until it was clicked, and a review is READ before
 * it is clicked. The cap now bounds the pathological case it was always meant for (a mass rename, a fresh clone)
 * and nothing else; an ordinary review of any size falls inside it, which is the point.
 *
 * The rows past it are not lost, only unsettled: their badge holds git's count at half weight until something reads
 * them (ReviewStat), and clicking one costs what clicking any row cost before any of this existed. */
export const WARM_LIMIT = 120;

export interface WarmRow {
    readonly repo: string;
    readonly path: string;
    readonly side: GitDiffSide;
}

// Unscannable repos have no rows to read; the panel renders them as their error and nothing else.
export const warmRows = (repos: readonly RepoChanges[], limit: number = WARM_LIMIT): readonly WarmRow[] =>
    repos
        .filter((repo) => repo.error === undefined)
        .flatMap((repo) => SIDES.flatMap((side) => repo[side].map((change) => ({ repo: repo.repo, path: change.path, side }))))
        .slice(0, limit);
