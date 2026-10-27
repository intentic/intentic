import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import type { GitActionResult, GitPublishFileResult } from "@intentic/sandbox-contract/schemas/git/git-history";
import { REMOTE_REPOS, writeFile } from "../../fixture/workspace";
import { checkpoint } from "./checkpoints";
import { addCommit, graphOf, isAncestor, moveHead, onlyIn, REMOTE, refsMoved, type Repo, tipOf } from "./gitGraph";
import { replay } from "./gitRewrite";

// The remote side of git against a simulated `origin`: fetch brings down what it holds, pull levels the branch onto it,
// a push runs as the daemon runs one (push-run.ts: started, answered at once, polled until it settles) at a pace a
// person can watch, and the remote takes it or refuses it the way a real one would. Tag pushes and the one-file publish
// go the same way. Ahead and behind move with every one of them.

/** How long a push takes, pre-push hook included: long enough to watch the row say it is pushing. */
const PUSH_MS = 2_800;
/** A network round trip for fetch, pull and a tag push. */
const NETWORK_MS = 900;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const remoteUrl = (id: string): string => {
    const project = REMOTE_REPOS.find((entry) => entry.repo === id);
    return project === undefined ? `${REMOTE}` : `${project.host}:${project.project}.git`;
};

const NO_REMOTE = `fatal: '${REMOTE}' does not appear to be a git repository`;

/** Brings the remote's branches down into the remote-tracking ones; answers whether anything moved. */
const fetchInto = (repo: Repo): boolean => {
    let moved = false;
    for (const [branch, sha] of repo.server) {
        moved ||= repo.fetched.get(branch) !== sha;
        repo.fetched.set(branch, sha);
    }
    return moved;
};

export const fetch = async (id: string): Promise<GitActionResult> => {
    const repo = graphOf(id);
    await wait(NETWORK_MS);
    if (!repo.hasRemote) {
        return { ok: false, reason: NO_REMOTE };
    }
    if (fetchInto(repo)) {
        refsMoved(id);
    }
    return { ok: true } as const;
};

// Fetch, then level the branch onto its upstream: a fast-forward, or the local commits replayed on top (the daemon's
// `git replay`), refused when both sides changed the same file.
export const pull = async (id: string): Promise<GitActionResult> => {
    const repo = graphOf(id);
    checkpoint(`user`, `before pull`);
    await wait(NETWORK_MS);
    const branch = repo.head.branch;
    const upstream = branch === undefined ? undefined : repo.upstreams.get(branch);
    if (branch === undefined || upstream === undefined) {
        return { ok: false, reason: branch === undefined ? `no branch checked out` : `${branch} has no upstream to pull from` };
    }
    fetchInto(repo);
    const theirs = repo.fetched.get(upstream.slice(REMOTE.length + 1));
    const head = tipOf(repo);
    if (theirs === undefined || isAncestor(repo, theirs, head)) {
        return { ok: true } as const;
    }
    if (isAncestor(repo, head, theirs)) {
        moveHead(repo, theirs, `pull: Fast-forward`);
    } else {
        const mine = onlyIn(repo, head, theirs);
        const tip = mine.some((commit) => commit.parents.length > 1) ? undefined : replay(repo, mine, theirs);
        if (tip === undefined) {
            return { ok: false, reason: `${branch} and ${upstream} conflict; rebase in a terminal to resolve them` };
        }
        moveHead(repo, tip, `pull: replayed ${String(mine.length)} onto ${upstream}`);
    }
    refsMoved(id);
    return { ok: true } as const;
};

const runs = new Map<string, PushRun>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const idle = (repo: string): PushRun => ({ status: `idle`, repo, command: ``, output: `` });

// What the remote says to a push: it takes a branch whose tip descends from what it holds, and refuses the rest until
// they pull, as any forge does.
const settle = (repo: Repo, branch: string, running: PushRun): PushRun => {
    const tip = repo.branches.get(branch) ?? ``;
    const held = repo.server.get(branch);
    const url = remoteUrl(repo.id);
    const hook = `pre-push: checks passed\n`;
    const finished = { ...running, finishedAt: Date.now() };
    if (held !== undefined && !isAncestor(repo, held, tip)) {
        const reason = `! [rejected] ${branch} -> ${branch} (fetch first)`;
        const output = `${hook}To ${url}\n ${reason}\nerror: failed to push some refs to '${url}'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally. Pull before pushing again.\n`;
        return { ...finished, status: `failed`, exitCode: 1, output, reason, refusedBy: `remote` };
    }
    const fresh = held === undefined;
    const line = held === tip ? `Everything up-to-date` : fresh ? ` * [new branch]      ${branch} -> ${branch}` : `   ${(held ?? ``).slice(0, 7)}..${tip.slice(0, 7)}  ${branch} -> ${branch}`;
    repo.server.set(branch, tip);
    repo.fetched.set(branch, tip);
    if (!repo.upstreams.has(branch)) {
        repo.upstreams.set(branch, `${REMOTE}/${branch}`);
    }
    const tracking = fresh ? `branch '${branch}' set up to track '${REMOTE}/${branch}'.\n` : ``;
    return { ...finished, status: `passed`, exitCode: 0, output: `${hook}To ${url}\n${line}\n${tracking}` };
};

const refused = (id: string, reason: string): PushRun => {
    const now = Date.now();
    return { status: `error`, repo: id, command: `git push`, startedAt: now, finishedAt: now, output: ``, reason };
};

/** POST /git/{repo}/push: starts the run and answers at once; a second start while one runs joins it. */
export const startPush = (id: string, branch: string | undefined) => {
    const repo = graphOf(id);
    if (runs.get(id)?.status === `running`) {
        return { ok: true } as const;
    }
    const name = branch ?? repo.head.branch;
    if (name === undefined || !repo.branches.has(name)) {
        runs.set(id, refused(id, name === undefined ? `no branch checked out` : `${name} is not a local branch`));
        return { ok: true } as const;
    }
    if (!repo.hasRemote) {
        runs.set(id, refused(id, `no remote configured`));
        return { ok: true } as const;
    }
    const command = `git push ${repo.upstreams.has(name) ? `` : `-u `}${REMOTE} ${name}`;
    const running: PushRun = { status: `running`, repo: id, command, startedAt: Date.now(), output: `` };
    runs.set(id, running);
    timers.set(
        id,
        setTimeout(() => {
            timers.delete(id);
            runs.set(id, settle(repo, name, running));
            refsMoved(id);
        }, PUSH_MS),
    );
    return { ok: true } as const;
};

export const pushState = (id: string): PushRun => runs.get(id) ?? idle(id);

/** Stops a push still going; nothing reaches the remote. A settled one is left as it settled. */
export const cancelPush = (id: string) => {
    const timer = timers.get(id);
    const running = runs.get(id);
    if (timer !== undefined && running !== undefined) {
        clearTimeout(timer);
        timers.delete(id);
        runs.set(id, { ...running, status: `cancelled`, finishedAt: Date.now() });
    }
    return { ok: true } as const;
};

/** One tag to the remote, never every unpushed one. */
export const pushTag = async (id: string, name: string, remote: string): Promise<GitActionResult> => {
    const repo = graphOf(id);
    await wait(NETWORK_MS);
    if (!repo.hasRemote || remote !== REMOTE || !repo.tags.has(name)) {
        return { ok: false, reason: `push failed` };
    }
    repo.pushedTags.add(name);
    refsMoved(id);
    return { ok: true } as const;
};

const DEFAULT_BRANCH = `main`;

/** Write, commit that path alone, push: each step reported, a side branch or a missing remote said rather than raised. */
export const publishFile = async (id: string, path: string, content: string, message: string): Promise<GitPublishFileResult> => {
    const repo = graphOf(id);
    const branch = repo.head.branch;
    const steps = { wrote: false, committed: false, pushed: false, branch: branch ?? `HEAD`, defaultBranch: DEFAULT_BRANCH };
    if (branch !== DEFAULT_BRANCH) {
        return { ok: false, ...steps, reason: `on ${branch ?? `a detached HEAD`}, not ${DEFAULT_BRANCH}; switch to ${DEFAULT_BRANCH} to publish` };
    }
    writeFile(id === `root` ? path : `${id}/${path}`, content);
    const head = tipOf(repo);
    const made = addCommit(repo, { parents: head === `` ? [] : [head], subject: message, files: [{ path, after: content }] });
    moveHead(repo, made.sha, `commit: ${message}`);
    refsMoved(id);
    if (!repo.hasRemote) {
        return { ok: false, ...steps, wrote: true, committed: true, reason: `no remote configured` };
    }
    await wait(NETWORK_MS);
    const held = repo.server.get(branch);
    if (held !== undefined && !isAncestor(repo, held, made.sha)) {
        return { ok: false, ...steps, wrote: true, committed: true, reason: `the remote has commits this branch does not; pull, then publish again` };
    }
    repo.server.set(branch, made.sha);
    repo.fetched.set(branch, made.sha);
    refsMoved(id);
    return { ok: true, ...steps, wrote: true, committed: true, pushed: true };
};

