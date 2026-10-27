import type { GitBranches, GitChange, GitRemoteState } from "@intentic/sandbox-contract/schemas/git/git";
import type { GitCommit, GitCommitDiff, GitLog, UndoableAction, UndoKind } from "@intentic/sandbox-contract/schemas/git/git-history";
import type { FileDiff } from "@intentic/sandbox-contract/schemas/history";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { Binary } from "../../fixture/git/gitSeeds";
import { type Body, type Commit, type CommitFile, contentAt, countAhead, graphOf, REMOTE, type Repo, resolveRef, tipOf } from "./gitGraph";

// What the git routes read off a repo's graph (gitGraph.ts), in the daemon's shapes: the log `git log --all` draws, a
// commit's files and one file's two sides, the branch switcher's list, the sync position, the stash, and what undo would
// walk back.

const text = (body: Body | undefined): string => (body === undefined || body instanceof Binary ? `` : body);

// Lines added and removed between two versions, as numstat counts them: an LCS over lines, small files only, with a
// plain line-set count past that where an LCS would cost more than it tells.
const LCS_LIMIT = 250_000;
interface LineCounts {
    readonly additions: number;
    readonly deletions: number;
}
const lineCounts = (before: string, after: string): LineCounts => {
    const old = before === `` ? [] : before.replace(/\n$/u, ``).split(`\n`);
    const now = after === `` ? [] : after.replace(/\n$/u, ``).split(`\n`);
    if (old.length * now.length > LCS_LIMIT) {
        const kept = new Set(old);
        const common = now.filter((line) => kept.has(line)).length;
        return { additions: now.length - common, deletions: Math.max(0, old.length - common) };
    }
    let row: number[] = Array.from({ length: now.length + 1 }, () => 0);
    for (const line of old) {
        const next: number[] = Array.from({ length: now.length + 1 }, () => 0);
        for (let index = 1; index <= now.length; index += 1) {
            next[index] = line === now[index - 1] ? (row[index - 1] ?? 0) + 1 : Math.max(row[index] ?? 0, next[index - 1] ?? 0);
        }
        row = next;
    }
    const common = row[now.length] ?? 0;
    return { additions: now.length - common, deletions: old.length - common };
};

/** A commit's file as a change row: what happened to it and, for text, git's counts. */
export const changeOf = (file: CommitFile): GitChange => {
    const status = file.before === undefined ? `added` : file.after === undefined ? `deleted` : `modified`;
    if (file.before instanceof Binary || file.after instanceof Binary) {
        return { path: file.path, status };
    }
    return { path: file.path, status, ...lineCounts(text(file.before), text(file.after)) };
};

/** Both sides of a file, as the diff views take them. */
export const sidesOf = (before: Body | undefined, after: Body | undefined): FileDiff => {
    if (before instanceof Binary || after instanceof Binary) {
        return { binary: true };
    }
    const diff: FileDiff = {};
    if (before !== undefined) {
        diff.before = before;
    }
    if (after !== undefined) {
        diff.after = after;
    }
    return diff;
};

const commitOf = (repo: Repo, sha: string): Commit => {
    const found = resolveRef(repo, sha);
    const commit = found === undefined ? undefined : repo.commits.get(found);
    return commit ?? refuse(`fatal: bad object ${sha}`, 404);
};

// Every commit the refs reach, children before parents and newer before older among the ready ones: `--topo-order`.
const topoOrder = (repo: Repo): Commit[] => {
    const tips = [...repo.branches.values(), ...repo.fetched.values(), ...repo.tags.values(), tipOf(repo)];
    const seen = new Map<string, Commit>();
    const stack = tips.filter((tip) => tip !== ``);
    while (stack.length > 0) {
        const commit = repo.commits.get(stack.pop() ?? ``);
        if (commit !== undefined && !seen.has(commit.sha)) {
            seen.set(commit.sha, commit);
            stack.push(...commit.parents);
        }
    }
    const children = new Map<string, number>();
    for (const commit of seen.values()) {
        for (const parent of commit.parents) {
            children.set(parent, (children.get(parent) ?? 0) + 1);
        }
    }
    const ready = [...seen.values()].filter((commit) => (children.get(commit.sha) ?? 0) === 0);
    const order: Commit[] = [];
    while (ready.length > 0) {
        ready.sort((a, b) => b.at - a.at);
        const next = ready.shift();
        if (next === undefined) {
            break;
        }
        order.push(next);
        for (const parent of next.parents) {
            const left = (children.get(parent) ?? 0) - 1;
            children.set(parent, left);
            const commit = seen.get(parent);
            if (left === 0 && commit !== undefined) {
                ready.push(commit);
            }
        }
    }
    return order;
};

// The decorations `git log --decorate` puts on a commit: the checked-out branch first, then the others, the remote's,
// then tags with their `tag: ` prefix.
const refsOn = (repo: Repo, sha: string): string[] => {
    const locals = [...repo.branches].filter(([, tip]) => tip === sha).map(([name]) => name);
    locals.sort((a, b) => Number(b === repo.head.branch) - Number(a === repo.head.branch));
    const remotes = [...repo.fetched].filter(([, tip]) => tip === sha).map(([name]) => `${REMOTE}/${name}`);
    const tags = [...repo.tags].filter(([, tip]) => tip === sha).map(([name]) => `tag: ${name}`);
    return [...locals, ...remotes, ...tags];
};

const gitCommit = (repo: Repo, commit: Commit, head: string): GitCommit => ({
    sha: commit.sha,
    short: commit.sha.slice(0, 7),
    parents: [...commit.parents],
    subject: commit.subject,
    body: commit.body,
    author: commit.author,
    email: commit.email,
    at: commit.at,
    refs: refsOn(repo, commit.sha),
    head: commit.sha === head,
});

/** GET /git/{repo}/log: one page of every ref's commits, newest first. */
export const gitLog = (id: string, limit = 300, skip = 0): GitLog => {
    const repo = graphOf(id);
    const order = topoOrder(repo);
    const head = tipOf(repo);
    const log: GitLog = { repo: id, commits: order.slice(skip, skip + limit).map((commit) => gitCommit(repo, commit, head)), hasMore: order.length > skip + limit };
    if (repo.head.branch !== undefined) {
        log.branch = repo.head.branch;
    }
    return log;
};

export const commitDiff = (id: string, sha: string): GitCommitDiff => ({ files: commitOf(graphOf(id), sha).files.map(changeOf) });

export const commitFileDiff = (id: string, sha: string, path: string): FileDiff => {
    const repo = graphOf(id);
    const commit = commitOf(repo, sha);
    const file = commit.files.find((entry) => entry.path === path);
    if (file !== undefined) {
        return sidesOf(file.before, file.after);
    }
    const [parent] = commit.parents;
    return sidesOf(parent === undefined ? undefined : contentAt(repo, parent, path), contentAt(repo, commit.sha, path));
};

/** Where the checked-out branch stands against what this repo last fetched of its upstream. */
export const remoteState = (id: string): GitRemoteState => {
    const repo = graphOf(id);
    const state: GitRemoteState = { ahead: 0, behind: 0 };
    if (repo.hasRemote) {
        state.remote = REMOTE;
    }
    const branch = repo.head.branch;
    if (branch === undefined || tipOf(repo) === ``) {
        return state;
    }
    state.branch = branch;
    const upstream = repo.upstreams.get(branch);
    const tracked = upstream === undefined ? undefined : repo.fetched.get(upstream.slice(REMOTE.length + 1));
    if (upstream === undefined || tracked === undefined) {
        return state;
    }
    return { ...state, upstream, ahead: countAhead(repo, tipOf(repo), tracked), behind: countAhead(repo, tracked, tipOf(repo)) };
};

/** GET /git/{repo}/branches: every local branch with its drift, and the remote's as last fetched, newest first. */
export const branchList = (id: string): GitBranches => {
    const repo = graphOf(id);
    const at = (sha: string): number => repo.commits.get(sha)?.at ?? 0;
    const branches = [...repo.branches].map(([name, tip]) => {
        const upstream = repo.upstreams.get(name);
        const tracked = upstream === undefined ? undefined : repo.fetched.get(upstream.slice(REMOTE.length + 1));
        const row: GitBranches[`branches`][number] = {
            name,
            current: name === repo.head.branch,
            ahead: tracked === undefined ? 0 : countAhead(repo, tip, tracked),
            behind: tracked === undefined ? 0 : countAhead(repo, tracked, tip),
            at: at(tip),
        };
        if (upstream !== undefined) {
            row.upstream = upstream;
            if (tracked === undefined) {
                row.gone = true;
            }
        }
        return row;
    });
    const remotes = [...repo.fetched].map(([branch, tip]) => ({ name: `${REMOTE}/${branch}`, remote: REMOTE, branch, at: at(tip) }));
    return { branches: branches.sort((a, b) => b.at - a.at), remotes: remotes.sort((a, b) => b.at - a.at) };
};

export const stashList = (id: string): SandboxHandlerOutput<`git`, `stashes`> => ({
    repo: id,
    stashes: graphOf(id).stashes.map((stash, index) => ({
        ref: `stash@{${String(index)}}`,
        sha: stash.sha,
        short: stash.sha.slice(0, 7),
        subject: stash.subject,
        branch: stash.branch,
        at: stash.at,
        parents: [stash.base],
    })),
});

/** The stash entry `stash@{n}` names, as git refuses one that is not there. */
export const stashAt = (repo: Repo, ref: string): { index: number; stash: Repo[`stashes`][number] } => {
    const index = Number(/\{(\d+)\}/u.exec(ref)?.[1] ?? `-1`);
    const stash = repo.stashes[index];
    return stash === undefined ? refuse(`error: ${ref} is not a valid reference`, 404) : { index, stash };
};

export const stashDiff = (id: string, ref: string): GitCommitDiff => ({ files: stashAt(graphOf(id), ref).stash.files.map(changeOf) });

const WORKING_TREE_KINDS: ReadonlySet<UndoKind> = new Set([`merge`, `rebase`, `cherry-pick`, `revert`, `reset`, `pull`, `other`]);

// The reflog subject's verb, in the daemon's order (undo.ts): the parenthesised commit forms before the bare one.
const kindOf = (subject: string): UndoKind | undefined => {
    if (/^(branch|clone|checkout):/u.test(subject)) {
        return undefined;
    }
    const forms: readonly (readonly [string, UndoKind])[] = [
        [`commit (amend)`, `amend`],
        [`commit (merge)`, `merge`],
        [`commit (cherry-pick)`, `cherry-pick`],
        [`commit`, `commit`],
        [`pull --rebase`, `rebase`],
        [`revert`, `revert`],
        [`merge`, `merge`],
        [`rebase`, `rebase`],
        [`pull`, `pull`],
        [`reset`, `reset`],
        [`cherry-pick`, `cherry-pick`],
    ];
    return forms.find(([prefix]) => subject.startsWith(prefix))?.[1] ?? `other`;
};

/** What undo would walk back: the branch's last reflog move, unless a halted operation or a bare HEAD rules it out. */
export const undoableOf = (repo: Repo): UndoableAction | undefined => {
    const branch = repo.head.branch;
    if (repo.operation !== undefined || branch === undefined) {
        return undefined;
    }
    const [current, previous] = repo.reflog.get(branch) ?? [];
    if (current === undefined || previous === undefined || current.sha === previous.sha || current.sha !== repo.branches.get(branch)) {
        return undefined;
    }
    const kind = kindOf(current.subject);
    if (kind === undefined) {
        return undefined;
    }
    return { kind, description: current.subject, branch, sha: current.sha, previousSha: previous.sha, changesWorkingTree: WORKING_TREE_KINDS.has(kind) };
};
