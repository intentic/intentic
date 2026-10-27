import type { GitActionResult } from "@intentic/sandbox-contract/schemas/git/git-history";
import { refuse } from "@intentic/contract-serve";
import { checkpoint } from "./checkpoints";
import { graphOf, isAncestor, moveBranch, REMOTE, refsMoved, type Repo, resolveRef, tipOf } from "./gitGraph";
import { addPending, clearPending, pendingPaths } from "./gitPending";
import { stashAt } from "./gitReads";

// The ref verbs: switching, creating and deleting branches and tags, the stash's apply and drop, and abort. A branch or
// tag only adds a ref, so it takes no checkpoint; whatever moves the tree does, as the daemon's routes do. git's own
// refusals (a duplicate name, an unmerged branch, a ref that names nothing) answer as the daemon passes them on.

const OK = { ok: true } as const;

/** git refusing, in its own words, as the daemon passes the failure on. */
const gitSays = (message: string): never => refuse(message, 409);

const resolved = (repo: Repo, ref: string): string => resolveRef(repo, ref) ?? gitSays(`fatal: not a valid object name: '${ref}'`);

const newBranch = (repo: Repo, name: string, sha: string, from: string): void => {
    if (repo.branches.has(name)) {
        gitSays(`fatal: a branch named '${name}' already exists`);
    }
    moveBranch(repo, name, sha, `branch: Created from ${from}`);
};

// HEAD onto a branch, or onto a bare commit; a name only the remote has becomes a local branch following it, as
// `git checkout <name>` does when exactly one remote has that branch.
const switchTo = (repo: Repo, ref: string): void => {
    if (repo.branches.has(ref)) {
        repo.head = { branch: ref, detached: `` };
        return;
    }
    const remote = repo.fetched.get(ref);
    if (remote !== undefined) {
        newBranch(repo, ref, remote, `${REMOTE}/${ref}`);
        repo.upstreams.set(ref, `${REMOTE}/${ref}`);
        repo.head = { branch: ref, detached: `` };
        return;
    }
    const sha = resolveRef(repo, ref) ?? gitSays(`error: pathspec '${ref}' did not match any file(s) known to git`);
    repo.head = { branch: undefined, detached: sha };
};

export const checkout = (id: string, ref: string) => {
    const repo = graphOf(id);
    checkpoint(`user`, `before checkout ${ref.slice(0, 12)}`);
    switchTo(repo, ref);
    refsMoved(id);
    return OK;
};

export const createBranch = (id: string, sha: string, name: string) => {
    const repo = graphOf(id);
    newBranch(repo, name, resolved(repo, sha), sha.slice(0, 7));
    refsMoved(id);
    return OK;
};

export const createBranchAt = (id: string, name: string, start: string | undefined, andCheckout: boolean) => {
    const repo = graphOf(id);
    const from = start ?? `HEAD`;
    if (andCheckout) {
        checkpoint(`user`, `before new branch ${name}`);
    }
    newBranch(repo, name, resolved(repo, from), from);
    if (andCheckout) {
        repo.head = { branch: name, detached: `` };
    }
    refsMoved(id);
    return OK;
};

export const deleteBranch = (id: string, name: string, force: boolean) => {
    const repo = graphOf(id);
    const tip = repo.branches.get(name) ?? gitSays(`error: branch '${name}' not found`);
    if (repo.head.branch === name) {
        gitSays(`error: cannot delete branch '${name}' used by worktree at '/work/${id}'`);
    }
    const upstream = repo.upstreams.get(name);
    const tracked = upstream === undefined ? undefined : repo.fetched.get(upstream.slice(REMOTE.length + 1));
    const merged = isAncestor(repo, tip, tipOf(repo)) || (tracked !== undefined && isAncestor(repo, tip, tracked));
    if (!merged && !force) {
        gitSays(`error: the branch '${name}' is not fully merged`);
    }
    repo.branches.delete(name);
    repo.upstreams.delete(name);
    repo.reflog.delete(name);
    refsMoved(id);
    return OK;
};

export const createTag = (id: string, sha: string, name: string) => {
    const repo = graphOf(id);
    if (repo.tags.has(name)) {
        gitSays(`fatal: tag '${name}' already exists`);
    }
    repo.tags.set(name, resolved(repo, sha));
    refsMoved(id);
    return OK;
};

// The remote half is best effort, as the daemon's is: a tag never pushed there does not fail the local delete.
export const deleteTag = (id: string, name: string, remote: string | undefined) => {
    const repo = graphOf(id);
    if (!repo.tags.delete(name)) {
        gitSays(`error: tag '${name}' not found.`);
    }
    if (remote === REMOTE) {
        repo.pushedTags.delete(name);
    }
    refsMoved(id);
    return OK;
};

// A stash's files back in the tree, unstaged; git refuses one whose files hold uncommitted work, and a pop keeps an
// entry it could not apply.
export const stashApply = (id: string, ref: string, pop: boolean, dirty: ReadonlySet<string>): GitActionResult => {
    const repo = graphOf(id);
    const { index, stash } = stashAt(repo, ref);
    checkpoint(`user`, `before stash ${pop ? `pop` : `apply`} in ${id}`);
    const blocked = stash.files.map((file) => file.path).filter((path) => dirty.has(path));
    if (blocked.length > 0) {
        return { ok: false, reason: `Your local changes to the following files would be overwritten by merge: ${blocked.join(`, `)}` };
    }
    addPending(repo, stash.files, `unstaged`);
    if (pop) {
        repo.stashes = repo.stashes.filter((_entry, at) => at !== index);
    }
    refsMoved(id);
    return { ok: true };
};

export const stashDrop = (id: string, ref: string) => {
    const repo = graphOf(id);
    const { index } = stashAt(repo, ref);
    checkpoint(`user`, `before dropping ${ref} in ${id}`);
    repo.stashes = repo.stashes.filter((_entry, at) => at !== index);
    refsMoved(id);
    return OK;
};

export const operation = (id: string) => {
    const repo = graphOf(id);
    return repo.operation === undefined ? { repo: id } : { repo: id, operation: repo.operation };
};

// A second Abort is ordinary: nothing in progress is an answer, not a failure.
export const abort = (id: string): GitActionResult => {
    const repo = graphOf(id);
    if (repo.operation === undefined) {
        return { ok: false, reason: `nothing in progress` };
    }
    checkpoint(`user`, `before aborting ${repo.operation} in ${id}`);
    repo.operation = undefined;
    clearPending(id, pendingPaths(id, `conflicted`));
    refsMoved(id);
    return { ok: true };
};
