import type { GitRemoteState } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { upstreamOf } from "./branches.js";
import type { ActionResult } from "./changes.js";
import { gitFailureReason } from "./git.js";

/* Talking to the remote: where the current branch stands relative to its upstream, and the three verbs that
 * move work across it. Everything here can fail for ordinary, expected reasons, no remote configured, no
 * upstream set, no credentials, a diverged history that won't fast-forward, so the outcomes are VALUES
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

// What stands in for "the remote this repo has" when no branch names one of its own, what a publish would
// target, and what tells the panel a sync bar is worth showing. `origin` by name, NOT the first line:
// `git remote` sorts alphabetically, so on a repo carrying an abandoned `gitlab` remote next to its
// `origin`, first-line-wins publishes new branches to the host the repo moved off. Only a repo without an
// `origin` at all falls back to the listing order.
const configuredRemote = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    const listed = await git(dir, ["remote"]).catch(() => undefined);
    const names = (listed?.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return names.includes("origin") ? "origin" : names[0];
};

// Where the checked-out branch stands: the remote it pushes to, its upstream ref, and how far each side has
// moved. Every field is optional-or-zero because every one of them is legitimately absent in a healthy repo
// (no remote yet, a fresh branch never pushed, a detached HEAD). Read-only and total, it never throws.
//
// `remote` is the branch's OWN remote whenever it tracks one, falling back to `origin` for a branch that has
// never been pushed (which is where a publish has to go). Those two differ in a fork, `origin` and `upstream`
// both configured, and the difference is the whole ballgame for push.
//
// ONE spawn in the steady state, and the order of the reads is the reason. This runs for every repo on every
// Changes scan, so each spawn here is a scan-wide multiplier:
//   - the BRANCH comes from the caller whenever it already holds one, the scan reads it off the same
//     status pass that produced the rows (changedFiles), and is one spawn only when nobody does;
//   - `upstreamOf`'s single for-each-ref then carries the tracking ref, its remote AND the ahead/behind
//     counts, which for a tracking branch is the WHOLE answer;
//   - `git remote`, repo configuration that changes on the order of never, is consulted only when the
//     branch has no upstream, because only the publish fallback needs it.
export const remoteState = async (
    dir: string,
    known: { readonly branch?: string | undefined } = {},
    git: GitRunner = defaultGit,
): Promise<GitRemoteState> => {
    const branch = known.branch ?? (await git(dir, ["branch", "--show-current"]).catch(() => undefined))?.stdout.trim();
    // No branch (detached HEAD, an unborn repo): the configured remote is still a true fact worth reporting,
    // it is what tells the panel a sync bar exists at all.
    if (branch === undefined || branch === "") {
        const configured = await configuredRemote(dir, git);
        return { ahead: 0, behind: 0, ...(configured !== undefined ? { remote: configured } : {}) };
    }
    const tracking = await upstreamOf(dir, branch, git).catch(() => undefined);
    if (tracking?.upstream !== undefined && tracking.upstream !== "" && tracking.remote !== undefined) {
        return { remote: tracking.remote, branch, upstream: tracking.upstream, ahead: tracking.ahead, behind: tracking.behind };
    }
    // A branch with no upstream, where a publish has to go, so THIS is the case that pays for `git remote`.
    const configured = await configuredRemote(dir, git);
    return {
        ...(configured !== undefined ? { remote: configured } : {}),
        branch,
        ahead: tracking?.ahead ?? 0,
        behind: tracking?.behind ?? 0,
    };
};

// Update remote-tracking refs without touching the worktree, the read that makes ahead/behind meaningful.
// `--prune` drops tracking refs for branches deleted on the remote, so a stale "behind" can't linger.
export const fetchRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["fetch", "--prune", "--quiet"], git);

// Pull with `--ff-only`: a pull that cannot fast-forward is reported as a failure the user resolves
// deliberately (rebase or merge from the graph) rather than the daemon silently creating a merge commit, or,
// worse, leaving the worktree mid-conflict. Nothing to abort, so this needs no runOrAbort bracket.
export const pullRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["pull", "--ff-only", "--quiet"], git);

// Push the named branch (default: the checked-out one) to the remote that branch tracks, setting its upstream
// when, and only when, it has none. Because this always names the remote and the branch explicitly, git does
// NOT refuse an untracked branch the way a bare `git push` would; it succeeds and silently leaves the branch
// with no upstream, so ahead/behind stays unreadable and the next push has to name everything again.
// Publishing with `-u` in exactly that case is what leaves a coherent state (VSCode's "Publish Branch"), and
// the `upstream === undefined` guard is what keeps it from ever repointing an upstream the user already chose.
//
// Naming the branch's OWN remote is what keeps a fork honest: with `origin` and `upstream` both configured,
// the first remote git lists is not the one a branch tracks, and pushing to it lands the commits somewhere the
// ahead count will never clear, a silent success that reads as a broken button.
//
// THE PLAN IS ITS OWN STEP, because two things execute it: this function, inline, for the daemon's internal
// pushes (a published file, an arriving workspace), and the owner's push, which runs the same argv in a
// visible terminal so the repository's pre-push hook has somewhere to print (git/push-run.ts). One planner is
// what keeps "which remote, which branch, publish or not" from being decided twice.
export type PushPlan = { readonly ok: true; readonly args: readonly string[]; readonly remote: string; readonly branch: string } | { readonly ok: false; readonly reason: string };

export const pushPlan = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<PushPlan> => {
    const state = await remoteState(dir, {}, git);
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
    return { ok: true, args: ["push", ...(publish ? ["-u"] : []), remote, branch], remote, branch };
};

export const pushBranch = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<ActionResult> => {
    const plan = await pushPlan(dir, options, git);
    if (!plan.ok) {
        return plan;
    }
    // `--quiet` here and not in the plan: nobody watches an inline push, and the terminal one WANTS git's
    // progress lines in the pane.
    return run(dir, [...plan.args, "--quiet"], git);
};
