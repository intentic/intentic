import { type GitChange, type GitDiffSide, type GitScope, UNATTRIBUTED_ORIGIN } from "./git.js";

// What a scope names, resolved against a repository's own status. One definition, read by the daemon when it acts on a
// scope and by the Changes panel when it asks the owner about one, so the question and the action cannot disagree.
// Sides are the verb's, not the scope's: staging reads the two not yet in the index; a scope narrows, never widens.

export interface ChangedSides {
    readonly conflicted: readonly GitChange[];
    readonly staged: readonly GitChange[];
    readonly unstaged: readonly GitChange[];
}

// Who landed each path, newest first, as `RepoChanges.origins` ships it; a rename's old path is keyed too.
export type ChangeOrigins = Readonly<Record<string, readonly string[]>>;

// What each verb can move; `git add` on an unmerged path settles a merge, so conflicts are stageable too.
export const STAGEABLE_SIDES: readonly GitDiffSide[] = ["unstaged", "conflicted"];
export const UNSTAGEABLE_SIDES: readonly GitDiffSide[] = ["staged"];
// Discard rewrites the worktree, which every side has one of.
export const DISCARDABLE_SIDES: readonly GitDiffSide[] = ["conflicted", "staged", "unstaged"];

// The paths one row stands for on disk: a rename is two, and no verb acts on half a move.
export const legsOf = (change: Pick<GitChange, "path" | "from">): readonly string[] =>
    change.from === undefined ? [change.path] : [change.path, change.from];

// Every conversation that landed either leg of a row, newest first per leg, each once.
export const originsOfChange = (change: Pick<GitChange, "path" | "from">, origins: ChangeOrigins): readonly string[] => [
    ...new Set(legsOf(change).flatMap((path) => origins[path] ?? [])),
];

// Whether a row is that origin's work: a conversation that landed either leg of it, or for the unattributed origin a row
// no conversation landed any leg of. A rename out of an agent's file is the agent's row, whoever renamed it, so the
// panel counts it, the scope moves it and the discard question names it under the same chip.
export const changeIsFrom = (change: Pick<GitChange, "path" | "from">, origin: string, origins: ChangeOrigins): boolean => {
    const ids = originsOfChange(change, origins);
    return origin === UNATTRIBUTED_ORIGIN ? ids.length === 0 : ids.includes(origin);
};

// Paths a scope resolves to, for a verb that moves `sides`; both legs of a rename included.
// Deduplicated: a path staged and edited again is two rows over one file, and a rename's legs can be named twice.
export const scopedPaths = (changed: ChangedSides, sides: readonly GitDiffSide[], scope: GitScope, origins: ChangeOrigins = {}): readonly string[] => {
    const origin = scope.origin;
    const reading = scope.side === undefined ? sides : sides.filter((side) => side === scope.side);
    const rows = reading.flatMap((side) => changed[side]);
    const named = origin === undefined ? rows : rows.filter((change) => changeIsFrom(change, origin, origins));
    return [...new Set(named.flatMap(legsOf))];
};

// A scope that narrows nothing is the whole repository; two of the three verbs say so to git directly, unenumerated.
export const isWholeRepo = (scope: GitScope): boolean => scope.side === undefined && scope.origin === undefined;

// What discarding `paths` does to each, read off the same status: a path the last commit does not hold leaves the disk
// (an untracked file, a staged new file, a rename's new leg), every other returns to its committed state. Mirrors the
// daemon's discard, which unstages first and then cleans what reads untracked.
export const discardOutcome = (changed: ChangedSides, paths: readonly string[]): { readonly deletes: readonly string[]; readonly restores: readonly string[] } => {
    const notInHead = new Set<string>();
    for (const change of changed.staged) {
        if (change.status === "added" || (change.status === "renamed" && change.from !== undefined)) {
            notInHead.add(change.path);
        }
    }
    // Untracked, unless the index deleted it from the last commit: that path is in HEAD and comes back.
    const indexDeleted = new Set(changed.staged.filter((change) => change.status === "deleted").map((change) => change.path));
    for (const change of changed.unstaged) {
        if (change.status === "added" && !indexDeleted.has(change.path)) {
            notInHead.add(change.path);
        }
    }
    const unique = [...new Set(paths)];
    return { deletes: unique.filter((path) => notInHead.has(path)), restores: unique.filter((path) => !notInHead.has(path)) };
};
