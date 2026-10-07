import { defaultGit, forkedExec, GIT_STALL_GUARD, type GitRunner } from "@intentic/base/git";
import { z } from "zod";
import type { ActionResult } from "../changes/changes-commits.js";
import { upstreamOf } from "../ops/branches.js";
import { gitFailureReason, identity } from "../git.js";

// Brings a checkout's branch up to what its upstream holds without ever leaving it mid-merge: the merge is built in
// memory (`merge-tree`, `commit-tree`) and the checkout only moves by a fast-forward onto the result, so a conflict,
// an uncommitted file the move would change, or a HEAD that moved meanwhile refuses and touches nothing.
//
// A merge, not the replay the Pull button does (remote.ts `pullRemote`): an agent's worktree is cut from main's local
// commits and measures its own work from where it forked (conversations/land/agent-changes.ts `checkpointOf`), so
// rewriting the commits no remote holds yet would hand every idle conversation the owner's commits as its own diff.

type Author = { readonly name: string; readonly email: string };

// The branch the checkout is on and the remote-tracking ref it follows.
export interface Tracked {
    readonly branch: string;
    readonly upstream: string;
    readonly remote: string;
}

export type FollowOutcome =
    // The upstream had nothing the branch lacked; `ahead` is what the owner has yet to push.
    | { readonly status: "current"; readonly ahead: number }
    | { readonly status: "fast-forwarded"; readonly commits: number; readonly head: string }
    | { readonly status: "merged"; readonly commits: number; readonly ahead: number; readonly head: string }
    // Both sides changed the same lines; nothing was written, and what clashes is named.
    | { readonly status: "conflicted"; readonly commits: number; readonly ahead: number; readonly paths: readonly string[] }
    // The merge was clean but the checkout could not move onto it: an uncommitted or untracked file in its way, or a
    // HEAD that moved between reading and moving.
    | { readonly status: "refused"; readonly commits: number; readonly reason: string };

// Long enough for a slow clone's fetch, short enough that a dead connection frees the next round. A stalled https
// transfer is aborted by git itself sooner (GIT_STALL_GUARD); anything else stalled is killed at this timeout.
const FETCH_TIMEOUT_MS = 90_000;

// Updates the remote-tracking refs of the one remote the branch follows, bounded in time and never prompting: nobody is
// at a background fetch to answer a password question, so it fails instead. ssh has no terminal here to ask on, and is
// left to the owner's own configuration (`core.sshCommand`, ~/.ssh/config), which an override would shadow.
export const fetchTracked = async (dir: string, remote: string): Promise<ActionResult> => {
    try {
        await forkedExec("git", ["-C", dir, ...GIT_STALL_GUARD, "fetch", "--quiet", "--no-write-fetch-head", remote], {
            timeout: FETCH_TIMEOUT_MS,
            env: { GIT_TERMINAL_PROMPT: "0" },
        });
        return { ok: true };
    } catch (cause) {
        return { ok: false, reason: gitFailureReason(cause, "git fetch failed") };
    }
};

// What a failed git run carries, as execFile throws it or the resident forker copies it: its exit code and both streams.
const GitFailureSchema = z.object({
    code: z.union([z.number(), z.string()]).optional().catch(undefined),
    stdout: z.string().catch(""),
    stderr: z.string().catch(""),
});

const shaOf = async (dir: string, ref: string, git: GitRunner): Promise<string> =>
    (await git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim();

// The merged tree, or the paths that clash. `merge-tree` exits 1 on a conflict with the tree and the conflicted paths
// on stdout; any other failure is not an answer and propagates.
const mergedTree = async (
    dir: string,
    ours: string,
    theirs: string,
    git: GitRunner,
): Promise<{ readonly tree: string } | { readonly conflicted: readonly string[] }> => {
    try {
        const { stdout } = await git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs]);
        return { tree: stdout.split("\n")[0]?.trim() ?? "" };
    } catch (cause) {
        const failure = GitFailureSchema.safeParse(cause);
        if (!failure.success || failure.data.code !== 1) {
            throw cause;
        }
        const paths = failure.data.stdout
            .split("\n")
            .slice(1)
            .map((line) => line.trim())
            .filter((line) => line !== "");
        return { conflicted: [...new Set(paths)] };
    }
};

// What stood in the checkout's way, with the paths git named (tab-indented under its error line).
const moveRefusal = (cause: unknown): string => {
    const failure = GitFailureSchema.safeParse(cause);
    const paths = (failure.success ? failure.data.stderr : "")
        .split("\n")
        .filter((line) => line.startsWith("\t"))
        .map((line) => line.trim());
    const reason = gitFailureReason(cause, "the checkout could not move");
    return paths.length === 0 ? reason : `${reason} ${paths.join(", ")}`;
};

export interface FollowOptions {
    readonly author: Author;
    // Runs once, right before the checkout moves, and only if it is about to: the place for a checkpoint.
    readonly beforeMove?: () => Promise<void>;
}

// Integrates what `fetchTracked` last brought in. The caller holds whatever serializes writers of this checkout.
export const followTracked = async (dir: string, tracked: Tracked, options: FollowOptions, git: GitRunner = defaultGit): Promise<FollowOutcome> => {
    const { ahead, behind } = await upstreamOf(dir, tracked.branch, git);
    if (behind === 0) {
        return { status: "current", ahead };
    }
    const ours = await shaOf(dir, "HEAD", git);
    const theirs = await shaOf(dir, tracked.upstream, git);
    let target = theirs;
    if (ahead > 0) {
        const merged = await mergedTree(dir, ours, theirs, git);
        if ("conflicted" in merged) {
            return { status: "conflicted", commits: behind, ahead, paths: merged.conflicted };
        }
        const message = `Merge remote-tracking branch '${tracked.upstream}'`;
        target = (await git(dir, [...identity(options.author), "commit-tree", merged.tree, "-p", ours, "-p", theirs, "-m", message])).stdout.trim();
    }
    await options.beforeMove?.();
    try {
        // A fast-forward: git refuses rather than overwrite an uncommitted or untracked file the move would change, and
        // refuses if HEAD moved on from `ours` meanwhile, since `target` does not descend from the commit it moved to.
        await git(dir, ["merge", "--ff-only", "--quiet", target], { GIT_REFLOG_ACTION: `follow ${tracked.upstream}` });
    } catch (cause) {
        return { status: "refused", commits: behind, reason: moveRefusal(cause) };
    }
    return ahead === 0 ? { status: "fast-forwarded", commits: behind, head: target } : { status: "merged", commits: behind, ahead, head: target };
};
