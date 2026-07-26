import type { GitRemoteState } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { upstreamOf } from "./branches.js";
import type { ActionResult } from "./changes.js";
import { gitFailureReason } from "./git.js";

/* Talking to the remote: where the current branch stands relative to its upstream, and the three verbs that
 * move work across it. Everything here can fail for ordinary, expected reasons — no remote configured, no
 * upstream set, no credentials, a diverged history that won't fast-forward — so the outcomes are VALUES
 * (`ActionResult`, an empty `GitRemoteState`) rather than exceptions the panel has to render as a 500.
 *
 * Nothing here ever prompts: `GIT_TERMINAL_PROMPT=0` is not set here because the daemon's git runs non-
 * interactively already (piped stdio), so a credential-less fetch fails fast instead of hanging on a prompt. */

const run = async (dir: string, args: readonly string[], git: GitRunner): Promise<ActionResult> => {
    try {
        await git(dir, args);
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, "git failed") };
    }
};

// Where the checked-out branch stands: the remote it pushes to, its upstream ref, and how far each side has
// moved. Every field is optional-or-zero because every one of them is legitimately absent in a healthy repo
// (no remote yet, a fresh branch never pushed, a detached HEAD). Read-only and total — it never throws.
//
// `remote` is the branch's OWN remote whenever it tracks one, falling back to the first `git remote` lists for
// a branch that has never been pushed (which is where a publish has to go). Those two differ in a fork —
// `origin` and `upstream` both configured — and the difference is the whole ballgame for push.
//
// Three spawns, not four: `upstreamOf`'s single for-each-ref carries the tracking ref, its remote AND the
// ahead/behind counts, so no separate `rev-parse @{upstream}` + `rev-list` pass is needed. This runs for every
// repo on every Changes scan, so its cost is not incidental.
export const remoteState = async (dir: string, git: GitRunner = defaultGit): Promise<GitRemoteState> => {
    const [remoteOut, branchOut] = await Promise.all([
        git(dir, ["remote"]).catch(() => undefined),
        git(dir, ["branch", "--show-current"]).catch(() => undefined),
    ]);
    // `git remote` lists one per line; the first stands in for "the remote this repo has" when no branch names
    // one of its own — it is what a publish would target, and what tells the panel a sync bar is worth showing.
    const configured = remoteOut?.stdout
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim();
    const branch = branchOut?.stdout.trim();
    // Report whichever of the two is known even when the other isn't: the checked-out branch is a true fact
    // about the repo with or without a remote, and pushBranch reads it from here to name its refspec.
    if (configured === undefined || branch === undefined || branch === "") {
        return {
            ahead: 0,
            behind: 0,
            ...(configured !== undefined ? { remote: configured } : {}),
            ...(branch !== undefined && branch !== "" ? { branch } : {}),
        };
    }
    const tracking = await upstreamOf(dir, branch, git).catch(() => undefined);
    return {
        remote: tracking?.remote ?? configured,
        branch,
        ...(tracking?.upstream !== undefined ? { upstream: tracking.upstream } : {}),
        ahead: tracking?.ahead ?? 0,
        behind: tracking?.behind ?? 0,
    };
};

// Update remote-tracking refs without touching the worktree — the read that makes ahead/behind meaningful.
// `--prune` drops tracking refs for branches deleted on the remote, so a stale "behind" can't linger.
export const fetchRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["fetch", "--prune", "--quiet"], git);

// Pull with `--ff-only`: a pull that cannot fast-forward is reported as a failure the user resolves
// deliberately (rebase or merge from the graph) rather than the daemon silently creating a merge commit — or,
// worse, leaving the worktree mid-conflict. Nothing to abort, so this needs no runOrAbort bracket.
export const pullRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["pull", "--ff-only", "--quiet"], git);

// Push the named branch (default: the checked-out one) to the remote that branch tracks, setting its upstream
// when — and only when — it has none. Because this always names the remote and the branch explicitly, git does
// NOT refuse an untracked branch the way a bare `git push` would; it succeeds and silently leaves the branch
// with no upstream, so ahead/behind stays unreadable and the next push has to name everything again.
// Publishing with `-u` in exactly that case is what leaves a coherent state (VSCode's "Publish Branch"), and
// the `upstream === undefined` guard is what keeps it from ever repointing an upstream the user already chose.
//
// Naming the branch's OWN remote is what keeps a fork honest: with `origin` and `upstream` both configured,
// the first remote git lists is not the one a branch tracks, and pushing to it lands the commits somewhere the
// ahead count will never clear — a silent success that reads as a broken button.
export const pushBranch = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<ActionResult> => {
    const state = await remoteState(dir, git);
    const branch = options.branch ?? state.branch;
    if (branch === undefined || branch === "") {
        return { ok: false, reason: "no branch checked out" };
    }
    // The state read is for the CHECKED-OUT branch, so its tracking only speaks for an unnamed push. Pushing
    // some other branch by name re-reads that branch's own upstream rather than borrowing HEAD's.
    const tracking =
        options.branch === undefined || options.branch === state.branch
            ? { upstream: state.upstream, remote: state.remote }
            : await upstreamOf(dir, branch, git).catch(() => undefined);
    // A never-pushed branch has no remote of its own; it publishes to the repo's configured one.
    const remote = tracking?.remote ?? state.remote;
    if (remote === undefined) {
        return { ok: false, reason: "no remote configured" };
    }
    const publish = tracking?.upstream === undefined || tracking.upstream === "";
    return run(dir, ["push", ...(publish ? ["-u"] : []), "--quiet", remote, branch], git);
};
