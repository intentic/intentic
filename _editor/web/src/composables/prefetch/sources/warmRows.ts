import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";

/* WHICH ROWS OF A REVIEW ARE WORTH READING AHEAD, AND IN WHAT ORDER.
 *
 * A LEAF — a pure projection over the change list, no store, no query, no Vue — for the same reason agentStatus
 * is one: the source that builds the wishes, the panel that draws the rows, and the test that pins the order can
 * all reach the same answer without any of them dragging in the app shell. */

// The panel's own reading order: conflicts first (they block the commit), then staged, then unstaged, repo by
// repo. Reading ahead in a different order than the list is drawn in would warm the rows the reader reaches last.
const SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

/* How far down the list one pass reads. A review is normally shorter than this, so the common case is "all of
 * it"; the cap is here for the ones that are not — a mass rename or a fresh clone ships hundreds of rows, and
 * reading every one of them would spend minutes of daemon time on files nobody is going to open. The rows past
 * it are not lost, only cold: clicking one costs exactly what clicking any row cost before this existed. */
export const WARM_LIMIT = 30;

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
