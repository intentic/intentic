import type { GitChange, GitDiffSide, GitScope } from "@intentic/sandbox-contract";

/* WHAT A SCOPE NAMES, resolved against the repository's own status rather than against a list somebody sent.
 *
 * This is the half of the Changes panel's contract that used to live in the browser, and moving it here is the
 * whole point of GitScopeSchema. A review has to stop drawing rows somewhere (git.routes' MAX_REPO_CHANGES),
 * and while the panel expressed "stage all" as "the paths of the rows I drew", every bulk verb inherited that
 * ceiling: five hundred files a click, on a change set that could easily be fifty times that, with no way to
 * reach the remainder except to keep clicking. Resolved here it costs one `git status` however large the
 * answer, it cannot be stale, and it cannot disagree with what the same read tells the panel.
 *
 * The sides are the VERB's, not the scope's: staging moves a path INTO the index, so it reads the two sides
 * that are not in it yet, and unstaging reads the one that is. A scope narrows that; it cannot widen it. So a
 * caller asking to stage the staged side gets nothing, which is the honest answer — the alternative, silently
 * re-adding the worktree over an index entry the user deliberately froze, is the one outcome nobody wants.
 */

export interface ChangedSides {
    readonly conflicted: readonly GitChange[];
    readonly staged: readonly GitChange[];
    readonly unstaged: readonly GitChange[];
}

// What each verb can move, ordered as the panel lists them. `git add` on an unmerged path is how you tell git
// the merge is settled, so conflicts are stageable; nothing else is a side a path can be moved out of.
export const STAGEABLE_SIDES: readonly GitDiffSide[] = ["unstaged", "conflicted"];
export const UNSTAGEABLE_SIDES: readonly GitDiffSide[] = ["staged"];
// Discard rewrites the worktree, which every side has one of.
export const DISCARDABLE_SIDES: readonly GitDiffSide[] = ["conflicted", "staged", "unstaged"];

// Whether one landed conversation put this change where it is. Both legs of a rename are consulted: attribution
// is keyed by path and a rename is two of them, so an agent that created `b` by moving `a` is named under
// whichever leg the land recorded.
const landedBy = (change: GitChange, origin: string, origins: Readonly<Record<string, readonly string[]>>): boolean =>
    (origins[change.path] ?? []).includes(origin) || (change.from !== undefined && (origins[change.from] ?? []).includes(origin));

/* The paths a scope resolves to, for a verb that can move `sides`.
 *
 * BOTH LEGS OF A RENAME, because a rename is one change over two paths and acting on half of it leaves the
 * index describing a move that did not happen: unstage only the new name and the old one stays deleted in the
 * index. `discardPaths` has always widened its own list this way; every verb needs it for the same reason.
 *
 * Deduplicated, since a path that is staged AND edited again is two rows over one file, and a rename's legs can
 * be named twice over.
 */
export const scopedPaths = (
    changed: ChangedSides,
    sides: readonly GitDiffSide[],
    scope: GitScope,
    origins: Readonly<Record<string, readonly string[]>> = {},
): readonly string[] => {
    const origin = scope.origin;
    const reading = scope.side === undefined ? sides : sides.filter((side) => side === scope.side);
    const rows = reading.flatMap((side) => changed[side]);
    const named = origin === undefined ? rows : rows.filter((change) => landedBy(change, origin, origins));
    return [...new Set(named.flatMap((change) => (change.from === undefined ? [change.path] : [change.path, change.from])))];
};

// A scope that narrows nothing is the whole repository, which two of the three verbs can say to git directly
// (`git add -A`, `git reset --hard` + `clean`) and so never need to enumerate at all.
export const isWholeRepo = (scope: GitScope): boolean => scope.side === undefined && scope.origin === undefined;
