import type { GitChange, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { FileDiff } from "@intentic/sandbox-contract/schemas/history";
import { Binary } from "../../fixture/git/gitSeeds";
import { demoQuiet } from "../../mode";
import { afterBuild, type Body, type CommitFile, contentAt, type Repo, tipOf } from "./gitGraph";
import { changeOf, sidesOf } from "./gitReads";

// Uncommitted work a git verb put into the tree, on top of the recording's own (fixture/workspace.ts): a soft reset or
// undo leaves the commits it walked back staged, a mixed one unstaged, an applied stash its files unstaged, and a halted
// cherry-pick its conflicted file. gitIndex.ts merges these rows into the Changes panel; the file-diff route answers their
// two sides from here, since the recording carries no diff for them.

type Side = `staged` | `unstaged` | `conflicted`;

interface Pending {
    readonly side: Side;
    readonly change: GitChange;
    readonly before: Body | undefined;
    readonly after: Body | undefined;
}

/** By repo, then path. */
const pending = new Map<string, Map<string, Pending>>();

const rowsOf = (repo: string): Map<string, Pending> => {
    const rows = pending.get(repo) ?? new Map<string, Pending>();
    pending.set(repo, rows);
    return rows;
};

/** Puts files into the tree as uncommitted work on one side, each measured against what HEAD holds now. */
export const addPending = (repo: Repo, files: readonly CommitFile[], side: Side): void => {
    const rows = rowsOf(repo.id);
    const head = tipOf(repo);
    for (const file of files) {
        const before = head === `` ? undefined : contentAt(repo, head, file.path);
        const change = changeOf({ path: file.path, before, after: file.after });
        rows.set(file.path, { side, change: side === `conflicted` ? { ...change, status: `conflicted` } : change, before, after: file.after });
    }
};

/** A hard reset or a discard: the tree matches HEAD again, so none of these rows is pending any more. */
export const clearPending = (repo: string, paths?: readonly string[]): void => {
    if (paths === undefined) {
        pending.delete(repo);
        return;
    }
    for (const path of paths) {
        pending.get(repo)?.delete(path);
    }
};

/** Moves rows between staged and unstaged, as the index verbs do; a conflicted row staged is resolved. */
export const movePending = (repo: string, paths: readonly string[], side: `staged` | `unstaged`): void => {
    const rows = rowsOf(repo);
    for (const path of paths) {
        const row = rows.get(path);
        if (row !== undefined) {
            rows.set(path, { ...row, side, change: { ...row.change, status: row.change.status === `conflicted` ? `modified` : row.change.status } });
        }
    }
};

export const pendingPaths = (repo: string, side?: Side): string[] =>
    [...(pending.get(repo) ?? new Map<string, Pending>())].filter(([, row]) => side === undefined || row.side === side).map(([path]) => path);

/** What a commit records for a pending file: its new content, or nothing for one deleted. */
export const pendingAfter = (repo: string, path: string): { readonly after: Body | undefined } | undefined => {
    const row = pending.get(repo)?.get(path);
    return row === undefined ? undefined : { after: row.after };
};

/** Lays these rows over the recording's own: a path here replaces the recording's row for it. */
export const withPending = (row: RepoChanges): RepoChanges => {
    const rows = pending.get(row.repo);
    if (rows === undefined || rows.size === 0) {
        return row;
    }
    const mine = (side: Side): GitChange[] => [...rows.values()].filter((entry) => entry.side === side).map((entry) => entry.change);
    const other = (list: readonly GitChange[]): GitChange[] => list.filter((change) => !rows.has(change.path));
    return {
        ...row,
        conflicted: [...other(row.conflicted), ...mine(`conflicted`)],
        staged: [...other(row.staged), ...mine(`staged`)],
        unstaged: [...other(row.unstaged), ...mine(`unstaged`)],
    };
};

// A conflicted file as the tree holds it: both sides between git's markers.
const markers = (ours: Body | undefined, theirs: Body | undefined, label: string): string => {
    const text = (body: Body | undefined): string => (body === undefined || body instanceof Binary ? `` : body);
    return `<<<<<<< HEAD\n${text(ours)}=======\n${text(theirs)}>>>>>>> ${label}\n`;
};

/** Halts the repo mid-cherry-pick on these files, as a terminal left it: the conflict a person resolves or aborts. */
const haltOn = (repo: Repo, label: string, theirs: readonly CommitFile[]): void => {
    const head = tipOf(repo);
    addPending(
        repo,
        theirs.map((file) => ({ path: file.path, after: markers(contentAt(repo, head, file.path), file.after, label) })),
        `conflicted`,
    );
};

/** GET /git/{repo}/file-diff for a row a git verb made; undefined for the recording's own rows. */
export const pendingDiff = (repo: string, path: string): FileDiff | undefined => {
    const row = pending.get(repo)?.get(path);
    return row === undefined ? undefined : sidesOf(row.before, row.after);
};

// The recording packs a cherry-pick stopped on a conflict into `Everything`, so the halted banner and its Abort have
// something to end; every quiet mode serves the repo clean.
afterBuild.push((repo) => {
    const picked = repo.halted === undefined ? undefined : repo.commits.get(repo.halted);
    if (picked === undefined || demoQuiet()) {
        return;
    }
    repo.operation = `cherry-pick`;
    haltOn(repo, `${picked.sha.slice(0, 7)} (${picked.subject})`, picked.files);
});
