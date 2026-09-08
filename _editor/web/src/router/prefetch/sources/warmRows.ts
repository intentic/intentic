import type { GitDiffSide, RepoChanges } from "@intentic/api-contract";

// Which rows of a review are worth reading ahead, and in what order. Pure projection over the change
// list, no store, no Vue, so the wish-builder, the panel and the ordering test all agree without pulling in the app
// shell.

// Must match the panel's own draw order: conflicted, staged, unstaged, repo by repo.
const SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

// Rows read per pass; generous, since a review is read, not sampled — only pathological cases hit the cap.
export const WARM_LIMIT = 120;

export interface WarmRow {
    readonly repo: string;
    readonly path: string;
    readonly side: GitDiffSide;
}

// Unscannable repos contribute no rows; the panel renders them as their error only.
export const warmRows = (repos: readonly RepoChanges[], limit: number = WARM_LIMIT): readonly WarmRow[] =>
    repos
        .filter((repo) => repo.error === undefined)
        .flatMap((repo) => SIDES.flatMap((side) => repo[side].map((change) => ({ repo: repo.repo, path: change.path, side }))))
        .slice(0, limit);
