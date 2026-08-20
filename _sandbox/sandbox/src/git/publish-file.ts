import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { GitPublishFileResult } from "@intentic/sandbox-contract";
import { AGENT_GIT_AUTHOR, gitFailureReason } from "./git.js";
import { operationInProgress } from "./operation.js";
import { pushBranch, remoteState } from "./remote.js";

/* PUTTING ONE FILE WHERE THE PUBLIC INTERNET CAN READ IT, write, commit that path alone, push, and say how
 * far it got.
 *
 * The publisher claim is what this exists for. Proving a publisher name means committing a challenge file to a
 * repository the official registry already lists, and until now that was a chore the creator did by hand in a
 * terminal: copy a token, find the repo, write the file, commit, push, come back and press verify. Every step
 * of that is something the daemon already does, for a repo it can already see, so it does all of them.
 *
 * THE ONE THING THAT MAKES IT DIFFERENT FROM COMMIT-THEN-PUSH. A proof is only a proof if it is on the DEFAULT
 * branch: the verifier reads `raw.githubusercontent.com/<repo>/HEAD/<file>`, and HEAD there resolves to
 * whatever branch the remote calls default. Committing to the side branch the creator happens to be on would
 * push a real commit that can never verify, and leave them with a stray file to clean up. So the branch is
 * checked BEFORE anything is written, and a mismatch is a refusal that names both branches. */

// The remote's default branch, the one a public `HEAD` read resolves to. `origin/HEAD` is a symbolic ref git
// writes at clone time, so the answer is usually local and free. A repo that was pushed rather than cloned has
// no such ref, and `ls-remote --symref` asks the remote itself; on a public repo that needs no credentials.
// Undefined ⇒ genuinely unknown, which is NOT the same as "does not match", see publishFile's use of it.
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

const identity = (author: { readonly name: string; readonly email: string }): string[] => [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
];

// Does the worktree differ from HEAD at this one path? Asked AFTER the write, to decide whether there is a
// commit to make at all, a creator who clicks twice, or who committed the file themselves and only failed to
// push it, must reach the push rather than a "nothing to commit" failure.
const pathIsDirty = async (dir: string, path: string, git: GitRunner): Promise<boolean> => {
    const { stdout } = await git(dir, ["status", "--porcelain", "--untracked-files=all", "--", path]);
    return stdout.trim() !== "";
};

export interface PublishFileInput {
    readonly path: string;
    readonly content: string;
    readonly message: string;
}

/* `write` is injected rather than done here so the path stays the router's business: it is the layer holding
 * `guardRepoPath`, and a file surface that resolves its own paths is one more place an escape has to be
 * re-proved. Everything else, the refusals, the ordering, the partial-run report, is the same everywhere
 * this is called from. */
export const publishFile = async (
    dir: string,
    file: PublishFileInput,
    write: (content: string) => Promise<void>,
    git: GitRunner = defaultGit,
): Promise<GitPublishFileResult> => {
    // Every refusal below happens BEFORE the write, which is what lets them all share this: nothing moved.
    const idle = { ok: false as const, wrote: false, committed: false, pushed: false };

    // Mid-sequence is checked first and refused rather than worked around: a partial commit is exactly what git
    // rejects while MERGE_HEAD exists, and it rejects it only after staging, so trying costs the user a moved
    // index for nothing (see changes.ts commitIndex, which was rewritten for the same reason).
    const operation = await operationInProgress(dir);
    if (operation !== undefined) {
        return { ...idle, reason: `this repo is part-way through a ${operation} — finish or abort that first` };
    }

    const state = await remoteState(dir, {}, git);
    if (state.branch === undefined) {
        return { ...idle, reason: `this repo has no branch checked out` };
    }
    if (state.remote === undefined) {
        return { ...idle, branch: state.branch, reason: `this repo has no remote, so nothing in it can be published` };
    }
    const defaultBranch = await defaultBranchOf(dir, state.remote, git);
    /* An UNKNOWN default branch is not a refusal. It happens on a repo whose `origin/HEAD` was never written and
     * whose remote cannot be reached right now, and refusing there would block a creator whose branch is very
     * probably the right one. The publish proceeds, the answer carries no `defaultBranch`, and the verify step
     * downstream is the one that gets to be sure. */
    if (defaultBranch !== undefined && defaultBranch !== state.branch) {
        return {
            ...idle,
            branch: state.branch,
            defaultBranch,
            reason: `you're on ${state.branch} and this has to land on ${defaultBranch} — switch branch and try again`,
        };
    }

    const at = { wrote: true, branch: state.branch, ...(defaultBranch !== undefined ? { defaultBranch } : {}) };
    await write(file.content);

    /* Nothing dirty after the write means the file is ALREADY there, byte-identical and committed. That is the
     * second click, and the repeat of a run whose push failed, both of which must fall through to the push
     * rather than die on git's "nothing to commit". Idempotence is not a nicety here: this button's whole
     * promise is that pressing it again is safe. */
    let committed = false;
    if (await pathIsDirty(dir, file.path, git)) {
        try {
            /* `--only <path>` commits this path's worktree state and NOTHING else, whatever the creator has
             * staged stays staged. That is the whole reason this does not reuse the panel's commit route, which
             * deliberately records the entire index.
             *
             * The `add` in front of it is not optional: `--only` refuses a path git has never heard of
             * ("pathspec did not match any file(s) known to git"), and the first run of this is always adding a
             * brand-new untracked file. Adding it moves ONE index entry, which the commit then clears, a
             * commit that fails in between leaves the claim file staged and visible in Changes, which is both
             * recoverable and exactly what `wrote: true, committed: false` is reported for. */
            await git(dir, ["add", "--", file.path]);
            await git(dir, [...identity(AGENT_GIT_AUTHOR), "commit", "-q", "--only", "-m", file.message, "--", file.path]);
            committed = true;
        } catch (error) {
            return { ...idle, ...at, reason: gitFailureReason(error, `git refused to commit the file`) };
        }
    }

    const pushed = await pushBranch(dir, { branch: state.branch }, git);
    if (!pushed.ok) {
        // The commit is real and local; saying so is the difference between a creator retrying the push and a
        // creator hunting for a file they think never got written.
        return { ok: false, ...at, committed, pushed: false, reason: pushed.reason };
    }
    return { ok: true, ...at, committed, pushed: true };
};
