import type { GitRemoteState } from "@intentic/sandbox-contract/schemas/git/git";
import { exitCodeOf, stderrOf } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
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

// The checked-out branch, or undefined when detached or unborn.
// allow(silent-catch): a repo git cannot read has no branch to name either, and every caller answers that case already.
const currentBranch = async (dir: string, git: GitRunner): Promise<string | undefined> =>
    (await git(dir, ["branch", "--show-current"]).catch(() => undefined))?.stdout.trim() || undefined;

// Every field is optional-or-zero and never thrown; no remote, no upstream, and detached HEAD are normal. `remote`
// falls back to `origin` only when the branch has no upstream of its own, and only then does this spawn `git remote`.
export const remoteState = async (
    dir: string,
    known: { readonly branch?: string | undefined } = {},
    git: GitRunner = defaultGit,
): Promise<GitRemoteState> => {
    const branch = known.branch ?? (await currentBranch(dir, git));
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
// allow(dependency-text): git reset --keep (run untranslated); no path read falls back to git's own verdict line.
const refusedPaths = (error: unknown): string[] =>
    (stderrOf(error) ?? "")
        .split("\n")
        .filter((line) => line.startsWith("error:"))
        .flatMap((line) => /'([^']+)'/.exec(line)?.[1] ?? []);

// Local-only commits rebuilt on `upstream` by `git replay`, which writes no file, index or ref; `reset --keep` then moves
// the checkout as a fast-forward would, refusing rather than touching an uncommitted file the move would change.
// `replay.refAction=print` keeps it that way: git 2.53 made replay move the refs itself by default, which would move the
// checked-out branch under an index and worktree left at the old tip. Older git ignores the key, and only prints.
const replayOnto = async (dir: string, branch: string, upstream: string, ahead: number, author: Author, git: GitRunner): Promise<ActionResult> => {
    const local = ahead === 1 ? "1 local commit" : `${ahead} local commits`;
    let replayed: string;
    try {
        const replay = ["-c", "replay.refAction=print", "replay", "--onto", upstream, `${upstream}..refs/heads/${branch}`];
        replayed = (await git(dir, [...identity(author), ...replay])).stdout;
    } catch (error) {
        // Exit 1 with nothing printed is a conflict; any other exit prints its own reason (a merge commit in range).
        return exitCodeOf(error) === 1
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

// Where a branch publishes, said once for push and pull: its upstream's own remote and ref, or, for a branch never
// pushed, the repo's configured remote under the branch's own name. So a pull before a first publish (one rejected
// because the remote already has the branch) levels with the very ref that publish will write, without assigning an
// upstream until it succeeds. Throws when the upstream cannot be read: a failed read must never send a tracked branch
// to another remote. Undefined when the repo has no remote at all.
interface Destination {
    readonly remote: string;
    readonly upstream: string;
    // Whether the branch already tracks it; a push that publishes it sets the upstream (`-u`).
    readonly tracked: boolean;
}

const destinationOf = async (dir: string, branch: string, git: GitRunner): Promise<Destination | undefined> => {
    const tracking = await upstreamOf(dir, branch, git);
    const remote = tracking.remote ?? (await configuredRemote(dir, git));
    return remote === undefined ? undefined : { remote, upstream: tracking.upstream ?? `${remote}/${branch}`, tracked: tracking.upstream !== undefined };
};

const pullTarget = async (dir: string, git: GitRunner): Promise<(Destination & { readonly branch: string }) | undefined> => {
    const branch = (await git(dir, ["branch", "--show-current"])).stdout.trim();
    if (branch === "") {
        return undefined;
    }
    const destination = await destinationOf(dir, branch, git);
    return destination === undefined ? undefined : { branch, ...destination };
};

// Levels a branch with its upstream, never with a merge commit: behind-only fast-forwards, diverged replays the
// local-only commits onto upstream. Every refusal leaves branch, index and worktree exactly as they were.
export const pullRemote = async (dir: string, author: Author, git: GitRunner = defaultGit): Promise<ActionResult> => {
    let tracked: Awaited<ReturnType<typeof pullTarget>>;
    try {
        tracked = await pullTarget(dir, git);
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, "could not read the branch's upstream") };
    }
    // Detached or without a remote: git's own pull names what is missing.
    if (tracked === undefined) {
        return run(dir, ["pull", "--ff-only", "--quiet"], git);
    }
    const fetched = await run(dir, ["fetch", "--quiet", tracked.remote], git);
    if (!fetched.ok) {
        return fetched;
    }
    // Count against the fetched destination even before this branch has an upstream. Refuse unrelated histories:
    // replaying their entire history would silently combine two different projects.
    let ahead: number;
    let behind: number;
    try {
        await git(dir, ["merge-base", `refs/heads/${tracked.branch}`, tracked.upstream]);
        const { stdout } = await git(dir, ["rev-list", "--left-right", "--count", `refs/heads/${tracked.branch}...${tracked.upstream}`]);
        const [left, right] = stdout.trim().split(/\s+/);
        ahead = Number(left);
        behind = Number(right);
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, `could not compare this branch with ${tracked.upstream}; check that they share history`) };
    }
    if (behind === 0) {
        return { ok: true };
    }
    if (ahead === 0) {
        return run(dir, ["merge", "--ff-only", "--quiet", tracked.upstream], git);
    }
    return replayOnto(dir, tracked.branch, tracked.upstream, ahead, author, git);
};

// The checked-out branch and what it tracks; undefined when detached, unborn or tracking nothing.
export const trackedBranch = async (dir: string, git: GitRunner = defaultGit): Promise<{ branch: string; upstream: string; remote: string } | undefined> => {
    const branch = await currentBranch(dir, git);
    if (branch === undefined) {
        return undefined;
    }
    const { upstream, remote } = await upstreamOf(dir, branch, git).catch(() => ({ upstream: undefined, remote: undefined }));
    return upstream === undefined || remote === undefined ? undefined : { branch, upstream, remote };
};

// Push plan: the branch's own remote (not the first configured one) and `-u` only when it has no upstream yet. Shared
// with the terminal push so remote/branch/publish is decided once.
export type PushPlan = { readonly ok: true; readonly args: readonly string[] } | { readonly ok: false; readonly reason: string };

export const pushPlan = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<PushPlan> => {
    const branch = options.branch ?? (await currentBranch(dir, git));
    if (branch === undefined || branch === "") {
        return { ok: false, reason: "no branch checked out" };
    }
    // A failed upstream read is refused, never planned as a first push: that would send the branch with `-u` to another
    // remote and repoint its upstream there.
    let destination: Destination | undefined;
    try {
        destination = await destinationOf(dir, branch, git);
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, "could not read the branch's upstream") };
    }
    if (destination === undefined) {
        return { ok: false, reason: "no remote configured" };
    }
    return { ok: true, args: ["push", ...(destination.tracked ? [] : ["-u"]), destination.remote, branch] };
};

export const pushBranch = async (dir: string, options: { readonly branch?: string }, git: GitRunner = defaultGit): Promise<ActionResult> => {
    const plan = await pushPlan(dir, options, git);
    if (!plan.ok) {
        return plan;
    }
    // `--quiet` here, not in the plan: an inline push has no watcher; the terminal one prints progress.
    return run(dir, [...plan.args, "--quiet"], git);
};
