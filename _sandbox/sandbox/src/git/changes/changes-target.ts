import type { GitChange, GitDiffSide, GitScope } from "@intentic/sandbox-contract";

// What a scope names, resolved against the repository's own status, not a list the caller sent.
// Sides are the verb's, not the scope's: staging reads the two not yet in the index; a scope narrows, never widens.

export interface ChangedSides {
    readonly conflicted: readonly GitChange[];
    readonly staged: readonly GitChange[];
    readonly unstaged: readonly GitChange[];
}

// What each verb can move; `git add` on an unmerged path settles a merge, so conflicts are stageable too.
export const STAGEABLE_SIDES: readonly GitDiffSide[] = ["unstaged", "conflicted"];
export const UNSTAGEABLE_SIDES: readonly GitDiffSide[] = ["staged"];
// Discard rewrites the worktree, which every side has one of.
export const DISCARDABLE_SIDES: readonly GitDiffSide[] = ["conflicted", "staged", "unstaged"];

// Whether a landed conversation put this change where it is; both legs of a rename are checked, keyed by path.
const landedBy = (change: GitChange, origin: string, origins: Readonly<Record<string, readonly string[]>>): boolean =>
    (origins[change.path] ?? []).includes(origin) || (change.from !== undefined && (origins[change.from] ?? []).includes(origin));

// Paths a scope resolves to, for a verb that moves `sides`; both legs of a rename included, none acts on half a move.
// Deduplicated: a path staged and edited again is two rows over one file, and a rename's legs can be named twice.
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

// A scope that narrows nothing is the whole repository; two of the three verbs say so to git directly, unenumerated.
export const isWholeRepo = (scope: GitScope): boolean => scope.side === undefined && scope.origin === undefined;
