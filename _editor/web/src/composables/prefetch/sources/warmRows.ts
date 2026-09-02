import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";

/* WHICH ROWS OF A REVIEW ARE WORTH READING AHEAD, AND IN WHAT ORDER.
 *
 * A LEAF, a pure projection over the change list, no store, no query, no Vue, for the same reason agentStatus
 * is one: the source that builds the wishes, the panel that draws the rows, and the test that pins the order can
 * all reach the same answer without any of them dragging in the app shell. */

// The panel's own reading order: conflicts first (they block the commit), then staged, then unstaged, repo by
// repo. Reading ahead in a different order than the list is drawn in would warm the rows the reader reaches last.
const SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

/* How far down the list one pass reads. GENEROUS, because a review is READ, not sampled.
 *
 * This used to be 30, on the reasoning that reading further spent daemon time on files nobody would open. What
 * warming buys is a click that paints immediately, and a reviewer walking a landing opens most of it, so the cap
 * is there for the pathological case it was always meant for (a mass rename, a fresh clone) and nothing else.
 *
 * It is no longer load-bearing for the NUMBERS. For a while it was: the +/− beside each row was worked out from
 * this very read, so a row past the cap could not be counted until it was clicked. The daemon ships those counts
 * with the list now (git/code-counts.ts), so a row this pass never reaches shows exactly the same numbers as one
 * it did — the only difference is whether its diff is already in hand when the reader gets there. */
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
