import type { GitActionResult } from "@intentic/sandbox-contract/schemas/git/git-history";
import { checkpoint } from "./checkpoints";
import {
    addCommit,
    AGENT_AUTHOR,
    type Body,
    type Commit,
    type CommitFile,
    contentAt,
    graphOf,
    isAncestor,
    moveHead,
    type NewCommit,
    onlyIn,
    reachable,
    REMOTE,
    refsMoved,
    type Repo,
    resolveRef,
    tipOf,
} from "./gitGraph";
import { settleAll } from "./gitIndex";
import { CONFLICTED, merge3 } from "./gitMerge";
import { addPending } from "./gitPending";
import { undoableOf } from "./gitReads";

// The graph's context-menu verbs that move HEAD or rewrite history: merge, rebase, cherry-pick, revert, drop, reset
// and undo, each as the daemon runs it (changes-commits.ts): a checkpoint first, then the git verb, a conflict answered
// as `ok: false` with the repo left as it was (the daemon aborts its own verbs cleanly), and the ref push after.

const OK: GitActionResult = { ok: true };
const CONFLICT: GitActionResult = { ok: false, reason: `conflict` };

// What the graph has a name for at a commit, as git's merge message names it.
const labelOf = (repo: Repo, sha: string): string => {
    const local = [...repo.branches].find(([, tip]) => tip === sha)?.[0];
    if (local !== undefined) {
        return `branch '${local}'`;
    }
    const remote = [...repo.fetched].find(([, tip]) => tip === sha)?.[0];
    return remote === undefined ? `commit '${sha.slice(0, 7)}'` : `remote-tracking branch '${REMOTE}/${remote}'`;
};

const touched = (commits: readonly Commit[]): Set<string> => new Set(commits.flatMap((commit) => commit.files.map((file) => file.path)));

// The newest commit both sides share: what a merge measures each side's change from.
const mergeBase = (repo: Repo, ours: string, theirs: string): string | undefined => {
    const mine = reachable(repo, [ours]);
    return [...reachable(repo, [theirs])]
        .filter((sha) => mine.has(sha))
        .map((sha) => repo.commits.get(sha))
        .filter((commit) => commit !== undefined)
        .sort((a, b) => b.at - a.at)[0]?.sha;
};

/** A commit's change carried onto `tip`, file by file; undefined where git would stop on a conflict. */
const carried = (repo: Repo, commit: Commit, tip: string, undo = false): NewCommit[`files`] | undefined => {
    const files: { path: string; after: Body | undefined }[] = [];
    for (const file of commit.files) {
        const merged = merge3(undo ? file.after : file.before, tip === `` ? undefined : contentAt(repo, tip, file.path), undo ? file.before : file.after);
        if (merged === CONFLICTED) {
            return undefined;
        }
        files.push({ path: file.path, after: merged });
    }
    return files;
};

/** Replays commits, oldest first, onto `base`: new commits with the same authors, messages and dates. Answers the new
 * tip, or undefined when one of them conflicts (the daemon aborts, so nothing moves). */
export const replay = (repo: Repo, commits: readonly Commit[], base: string): string | undefined => {
    let tip = base;
    for (const commit of commits) {
        const files = carried(repo, commit, tip);
        if (files === undefined) {
            return undefined;
        }
        tip = addCommit(repo, {
            parents: tip === `` ? [] : [tip],
            subject: commit.subject,
            body: commit.body,
            author: { name: commit.author, email: commit.email },
            at: commit.at,
            files,
        }).sha;
    }
    return tip;
};

// Every git verb here runs against the repo as it stands, after a `user` checkpoint labelled the daemon's way.
const guarded = (id: string, label: string, run: (repo: Repo, head: string) => GitActionResult): GitActionResult => {
    const repo = graphOf(id);
    checkpoint(`user`, label);
    const result = run(repo, tipOf(repo));
    if (result.ok) {
        refsMoved(id);
    }
    return result;
};

const target = (repo: Repo, sha: string): string | undefined => resolveRef(repo, sha);

export const merge = (id: string, sha: string): GitActionResult =>
    guarded(id, `before merge ${sha.slice(0, 8)}`, (repo, head) => {
        const theirs = target(repo, sha);
        if (theirs === undefined) {
            return CONFLICT;
        }
        const label = labelOf(repo, theirs);
        if (isAncestor(repo, theirs, head)) {
            return OK;
        }
        if (head === `` || isAncestor(repo, head, theirs)) {
            moveHead(repo, theirs, `merge ${label}: Fast-forward`);
            return OK;
        }
        const base = mergeBase(repo, head, theirs);
        const files: { path: string; after: Body | undefined }[] = [];
        for (const path of touched(onlyIn(repo, theirs, head))) {
            const ours = contentAt(repo, head, path);
            const merged = merge3(base === undefined ? undefined : contentAt(repo, base, path), ours, contentAt(repo, theirs, path));
            if (merged === CONFLICTED) {
                return CONFLICT;
            }
            if (merged !== ours) {
                files.push({ path, after: merged });
            }
        }
        const made = addCommit(repo, { parents: [head, theirs], subject: `Merge ${label}`, author: AGENT_AUTHOR, files });
        moveHead(repo, made.sha, `merge ${label}: Merge made by the 'ort' strategy.`);
        return OK;
    });

const finish = (repo: Repo, onto: string): string => `rebase (finish): refs/heads/${repo.head.branch ?? `HEAD`} onto ${onto}`;

export const rebase = (id: string, sha: string): GitActionResult =>
    guarded(id, `before rebase ${sha.slice(0, 8)}`, (repo, head) => {
        const onto = target(repo, sha);
        if (onto === undefined) {
            return CONFLICT;
        }
        if (isAncestor(repo, onto, head)) {
            return OK;
        }
        const mine = onlyIn(repo, head, onto);
        const tip = mine.some((commit) => commit.parents.length > 1) ? undefined : replay(repo, mine, onto);
        if (tip === undefined) {
            return CONFLICT;
        }
        moveHead(repo, tip, finish(repo, onto));
        return OK;
    });

export const cherryPick = (id: string, sha: string): GitActionResult =>
    guarded(id, `before cherry-pick ${sha.slice(0, 8)}`, (repo, head) => {
        const picked = repo.commits.get(target(repo, sha) ?? ``);
        // A merge needs a mainline git is not given, and a commit already in the branch leaves nothing to record.
        if (picked === undefined || picked.parents.length > 1 || isAncestor(repo, picked.sha, head)) {
            return CONFLICT;
        }
        const tip = replay(repo, [picked], head);
        if (tip === undefined) {
            return CONFLICT;
        }
        moveHead(repo, tip, `cherry-pick: ${picked.subject}`);
        return OK;
    });

/** A commit reversing another, as `git revert --no-edit` writes it. */
const revertIn = (repo: Repo, sha: string): GitActionResult => {
    const head = tipOf(repo);
    const undone = repo.commits.get(target(repo, sha) ?? ``);
    if (undone === undefined || undone.parents.length > 1 || head === ``) {
        return CONFLICT;
    }
    const subject = `Revert "${undone.subject}"`;
    const files = carried(repo, undone, head, true);
    if (files === undefined) {
        return CONFLICT;
    }
    const made = addCommit(repo, {
        parents: [head],
        subject,
        body: `This reverts commit ${undone.sha}.`,
        author: AGENT_AUTHOR,
        files,
    });
    moveHead(repo, made.sha, `revert: ${subject}`);
    return OK;
};

export const revert = (id: string, sha: string): GitActionResult => guarded(id, `before revert ${sha.slice(0, 8)}`, (repo) => revertIn(repo, sha));

// The commits after `sha` on HEAD's first-parent line, oldest first; undefined when `sha` is not on that line.
const after = (repo: Repo, head: string, sha: string): Commit[] | undefined => {
    const line: Commit[] = [];
    let at = repo.commits.get(head);
    while (at !== undefined && at.sha !== sha) {
        line.unshift(at);
        at = repo.commits.get(at.parents[0] ?? ``);
    }
    return at === undefined ? undefined : line;
};

export const drop = (id: string, sha: string): GitActionResult =>
    guarded(id, `before drop ${sha.slice(0, 8)}`, (repo, head) => {
        const dropped = repo.commits.get(target(repo, sha) ?? ``);
        const base = dropped?.parents[0];
        const later = dropped === undefined ? undefined : after(repo, head, dropped.sha);
        if (dropped === undefined || base === undefined || later === undefined || later.some((commit) => commit.parents.length > 1)) {
            return CONFLICT;
        }
        const tip = replay(repo, later, base);
        if (tip === undefined) {
            return CONFLICT;
        }
        moveHead(repo, tip, finish(repo, base));
        return OK;
    });

// The files that differ between two commits, as the newer one holds them: what a soft or mixed reset leaves pending.
const between = (repo: Repo, from: string, to: string): CommitFile[] =>
    [...touched([...onlyIn(repo, from, to), ...onlyIn(repo, to, from)])]
        .filter((path) => contentAt(repo, from, path) !== contentAt(repo, to, path))
        .map((path) => ({ path, after: contentAt(repo, from, path) }));

/** Moves the branch, and with it the index and the tree as the mode says, as `git reset --<mode>` does. */
const resetIn = (repo: Repo, to: string, mode: `soft` | `mixed` | `hard`, subject = `reset: moving to ${to}`): void => {
    const head = tipOf(repo);
    const left = between(repo, head, to);
    moveHead(repo, to, subject);
    if (mode === `hard`) {
        settleAll(repo.id);
        return;
    }
    addPending(repo, left, mode === `soft` ? `staged` : `unstaged`);
};

export const reset = (id: string, sha: string, mode: `soft` | `mixed` | `hard`): GitActionResult =>
    guarded(id, `before reset --${mode}`, (repo) => {
        const to = target(repo, sha);
        if (to === undefined) {
            return { ok: false, reason: `fatal: ambiguous argument '${sha}': unknown revision` };
        }
        resetIn(repo, to, mode, `reset: moving to ${sha}`);
        return OK;
    });

export const undo = (id: string, previousSha: string, discardChanges: boolean): GitActionResult =>
    guarded(id, `before undo in ${id}`, (repo) => {
        const action = undoableOf(repo);
        if (action === undefined) {
            return { ok: false, reason: `nothing to undo` };
        }
        if (!action.previousSha.startsWith(previousSha)) {
            return { ok: false, reason: `the repository moved since this undo was prepared` };
        }
        resetIn(repo, action.previousSha, discardChanges ? `hard` : `soft`, `reset: moving to ${action.previousSha}`);
        return OK;
    });
