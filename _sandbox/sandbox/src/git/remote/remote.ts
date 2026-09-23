import type { GitRemoteState } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { upstreamOf } from "../ops/branches.js";
import type { ActionResult } from "../changes/changes-commits.js";
import { gitFailureReason, identity } from "../git.js";

type Author = { readonly name: string; readonly email: string };

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

// `reset --keep` names each refused path in quotes on an `error:` line; the trailing `fatal:` names only a sha.
const refusedPaths = (error: unknown): string[] => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return (typeof stderr === "string" ? stderr : "")
        .split("\n")
        .filter((line) => line.startsWith("error:"))
        .flatMap((line) => /'([^']+)'/.exec(line)?.[1] ?? []);
};

// Local-only commits rebuilt on `upstream` by `git replay`, which writes no file, index or ref; `reset --keep` then moves
// the checkout as a fast-forward would, refusing rather than touching an uncommitted file the move would change.
const replayOnto = async (dir: string, branch: string, upstream: string, ahead: number, author: Author, git: GitRunner): Promise<ActionResult> => {
    const local = ahead === 1 ? "1 local commit" : `${ahead} local commits`;
    let replayed: string;
    try {
        replayed = (await git(dir, [...identity(author), "replay", "--onto", upstream, `${upstream}..refs/heads/${branch}`])).stdout;
    } catch (error) {
        // Exit 1 with nothing printed is a conflict; any other exit prints its own reason (a merge commit in range).
        return (error as { code?: unknown }).code === 1
            ? { ok: false, reason: `${local} conflict with ${upstream}; rebase in a terminal to resolve them` }
            : { ok: false, reason: gitFailureReason(error, "git replay failed") };
    }
    const prefix = `update refs/heads/${branch} `;
    const tip = replayed
        .split("\n")
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length)
        .split(" ")[0];
    if (tip === undefined || tip === "") {
        return { ok: false, reason: `git replay named no new tip for ${branch}` };
    }
    try {
        await git(dir, ["reset", "--quiet", "--keep", tip], { GIT_REFLOG_ACTION: `pull: replay onto ${upstream}` });
        return { ok: true };
    } catch (error) {
        const paths = refusedPaths(error);
        return paths.length === 0
            ? { ok: false, reason: gitFailureReason(error, "git reset failed") }
            : { ok: false, reason: `uncommitted changes to ${paths.join(", ")} overlap ${upstream}; commit or discard them, then sync` };
    }
};

// Levels a branch with its upstream, never with a merge commit: behind-only fast-forwards, diverged replays the
// local-only commits onto upstream. Every refusal leaves branch, index and worktree exactly as they were.
export const pullRemote = async (dir: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> => {
    const tracked = await trackedBranch(dir, git);
    // Detached or untracked: git's own pull names what is missing.
    if (tracked === undefined) {
        return run(dir, ["pull", "--ff-only", "--quiet"], git);
    }
    const fetched = await run(dir, ["fetch", "--quiet", tracked.remote], git);
    if (!fetched.ok) {
        return fetched;
    }
    // Re-read after the fetch: the counts that offered this pull predate it.
    const { ahead, behind } = await upstreamOf(dir, tracked.branch, git);
    if (behind === 0) {
        return { ok: true };
    }
    if (ahead === 0) {
        return run(dir, ["merge", "--ff-only", "--quiet", tracked.upstream], git);
    }
    return replayOnto(dir, tracked.branch, tracked.upstream, ahead, author, git);
};

const trackedBranch = async (dir: string, git: GitRunner): Promise<{ branch: string; upstream: string; remote: string } | undefined> => {
    const branch = (await git(dir, ["branch", "--show-current"]).catch(() => undefined))?.stdout.trim();
    if (branch === undefined || branch === "") {
        return undefined;
    }
    const { upstream, remote } = await upstreamOf(dir, branch, git).catch(() => ({ upstream: undefined, remote: undefined }));
    return upstream === undefined || remote === undefined ? undefined : { branch, upstream, remote };
};

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
