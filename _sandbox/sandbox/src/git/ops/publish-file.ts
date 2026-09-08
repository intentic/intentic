import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { GitPublishFileResult } from "@intentic/sandbox-contract";
import { AGENT_GIT_AUTHOR, gitFailureReason, identity } from "../git.js";
import { operationInProgress } from "./operation.js";
import { pushBranch, remoteState } from "../remote/remote.js";

// Writes one file, commits that path alone, pushes it, and reports how far it got — automating the publisher-claim flow
// a creator would otherwise do by hand. A proof only counts on the DEFAULT branch (the verifier reads `HEAD/<file>`),
// so the branch is checked before anything is written.

// The remote's default branch. `origin/HEAD` (local, free) covers a clone; a pushed-not-cloned repo falls back to
// `ls-remote --symref`. Undefined means genuinely unknown, not "does not match".
export const defaultBranchOf = async (dir: string, remote: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    const prefix = `${remote}/`;
    const local = await git(dir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]).catch(() => undefined);
    const short = local?.stdout.trim() ?? "";
    if (short.startsWith(prefix) && short.length > prefix.length) {
        return short.slice(prefix.length);
    }
    const remoteRead = await git(dir, ["ls-remote", "--symref", remote, "HEAD"]).catch(() => undefined);
    // `ref: refs/heads/main\tHEAD` on the first line, when the remote advertises a symref at all.
    const advertised = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remoteRead?.stdout ?? "")?.[1];
    return advertised === undefined || advertised === "" ? undefined : advertised;
};

// Does the worktree differ from HEAD at this path? Checked after the write, so a repeat click or an already-committed
// file still reaches the push instead of failing on "nothing to commit".
const pathIsDirty = async (dir: string, path: string, git: GitRunner): Promise<boolean> => {
    const { stdout } = await git(dir, ["status", "--porcelain", "--untracked-files=all", "--", path]);
    return stdout.trim() !== "";
};

export interface PublishFileInput {
    readonly path: string;
    readonly content: string;
    readonly message: string;
}

// `write` is injected so path resolution (guardRepoPath) stays the router's job; refusals, ordering and the partial-run
// report are the same for every caller.
export const publishFile = async (
    dir: string,
    file: PublishFileInput,
    write: (content: string) => Promise<void>,
    git: GitRunner = defaultGit,
): Promise<GitPublishFileResult> => {
    // Every refusal below happens BEFORE the write, which is what lets them all share this: nothing moved.
    const idle = { ok: false as const, wrote: false, committed: false, pushed: false };

    // Checked first: git rejects a partial commit while MERGE_HEAD exists, but only after staging, so trying would cost
    // a moved index for nothing.
    const operation = await operationInProgress(dir);
    if (operation !== undefined) {
        return { ...idle, reason: `this repo is part-way through a ${operation}, finish or abort that first` };
    }

    const state = await remoteState(dir, {}, git);
    if (state.branch === undefined) {
        return { ...idle, reason: `this repo has no branch checked out` };
    }
    if (state.remote === undefined) {
        return { ...idle, branch: state.branch, reason: `this repo has no remote, so nothing in it can be published` };
    }
    const defaultBranch = await defaultBranchOf(dir, state.remote, git);
    // An unknown default branch isn't a refusal (unwritten `origin/HEAD`, unreachable remote); the publish proceeds
    // without `defaultBranch`, and verify downstream is what confirms it.
    if (defaultBranch !== undefined && defaultBranch !== state.branch) {
        return {
            ...idle,
            branch: state.branch,
            defaultBranch,
            reason: `you're on ${state.branch} and this has to land on ${defaultBranch}, switch branch and try again`,
        };
    }

    const at = { wrote: true, branch: state.branch, ...(defaultBranch !== undefined ? { defaultBranch } : {}) };
    await write(file.content);

    // Nothing dirty after the write means the file is already committed (a second click, or a retry after a failed
    // push); both must reach the push, not die on git's "nothing to commit".
    let committed = false;
    if (await pathIsDirty(dir, file.path, git)) {
        try {
            // `--only` commits just this path, leaving other staged work untouched (why this skips the panel's
            // whole-index commit route). `add` first is required: `--only` refuses a path git's never heard of.
            await git(dir, ["add", "--", file.path]);
            await git(dir, [...identity(AGENT_GIT_AUTHOR), "commit", "-q", "--only", "-m", file.message, "--", file.path]);
            committed = true;
        } catch (error) {
            return { ...idle, ...at, reason: gitFailureReason(error, `git refused to commit the file`) };
        }
    }

    const pushed = await pushBranch(dir, { branch: state.branch }, git);
    if (!pushed.ok) {
        // The commit is real and local; reporting that spares a retry from turning into a hunt for a lost file.
        return { ok: false, ...at, committed, pushed: false, reason: pushed.reason };
    }
    return { ok: true, ...at, committed, pushed: true };
};
