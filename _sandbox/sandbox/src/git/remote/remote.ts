import type { GitRemoteState } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { upstreamOf } from "../ops/branches.js";
import type { ActionResult } from "../changes/changes-commits.js";
import { gitFailureReason } from "../git.js";

// Remote state and the fetch/pull/push verbs; failures return as `ActionResult` or an empty `GitRemoteState`, never an
// exception. Git here never prompts: piped stdio already runs non-interactively, so a credential-less fetch fails fast.

const run = async (dir: string, args: readonly string[], git: GitRunner): Promise<ActionResult> => {
    try {
        await git(dir, args);
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, "git failed") };
    }
};

// origin by name when present, else the first remote git lists (alphabetical order, not preference).
const configuredRemote = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    const listed = await git(dir, ["remote"]).catch(() => undefined);
    const names = (listed?.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    return names.includes("origin") ? "origin" : names[0];
};

// Every field is optional-or-zero and never thrown; no remote, no upstream, and detached HEAD are normal. `remote`
// falls back to `origin` only when the branch has no upstream of its own, and only then does this spawn `git remote`.
export const remoteState = async (
    dir: string,
    known: { readonly branch?: string | undefined } = {},
    git: GitRunner = defaultGit,
): Promise<GitRemoteState> => {
    const branch = known.branch ?? (await git(dir, ["branch", "--show-current"]).catch(() => undefined))?.stdout.trim();
    // No branch (detached HEAD, unborn repo): report the configured remote so a sync bar still shows.
    if (branch === undefined || branch === "") {
        const configured = await configuredRemote(dir, git);
        return { ahead: 0, behind: 0, ...(configured !== undefined ? { remote: configured } : {}) };
    }
    const tracking = await upstreamOf(dir, branch, git).catch(() => undefined);
    if (tracking?.upstream !== undefined && tracking.upstream !== "" && tracking.remote !== undefined) {
        return { remote: tracking.remote, branch, upstream: tracking.upstream, ahead: tracking.ahead, behind: tracking.behind };
    }
    // No upstream: this is the only case that needs `git remote`.
    const configured = await configuredRemote(dir, git);
    return {
        ...(configured !== undefined ? { remote: configured } : {}),
        branch,
        ahead: tracking?.ahead ?? 0,
        behind: tracking?.behind ?? 0,
    };
};

// Updates remote-tracking refs without touching the worktree, making ahead/behind meaningful. `--prune` drops refs for
// branches deleted upstream so a stale behind count can't linger.
export const fetchRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["fetch", "--prune", "--quiet"], git);

// `--ff-only` fails a non-fast-forward pull instead of creating a merge commit or a conflicted worktree; nothing to
// abort, so no runOrAbort bracket is needed.
export const pullRemote = async (dir: string, git: GitRunner = defaultGit): Promise<ActionResult> => run(dir, ["pull", "--ff-only", "--quiet"], git);

// Push plan: the branch's own remote (not the first configured one) and `-u` only when it has no upstream yet. Shared
// with the terminal push so remote/branch/publish is decided once.
export type PushPlan = { readonly ok: true; readonly args: readonly string[]; readonly remote: string; readonly branch: string } | { readonly ok: false; readonly reason: string };

export const pushPlan = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<PushPlan> => {
    const state = await remoteState(dir, {}, git);
    const branch = options.branch ?? state.branch;
    if (branch === undefined || branch === "") {
        return { ok: false, reason: "no branch checked out" };
    }
    // The state read covers only the checked-out branch; naming another branch re-reads its own upstream.
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
    // `--quiet` here, not in the plan: an inline push has no watcher; the terminal one prints progress.
    return run(dir, [...plan.args, "--quiet"], git);
};
