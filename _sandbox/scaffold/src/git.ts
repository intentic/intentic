import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultGit, type GitRunner } from "./exec.js";

// Generic git repo verbs over the injectable GitRunner (defaultGit shells to `git`). Shared by the CLI's
// init/scaffold-app/adopt and the sandbox daemon so both drive git identically. The daemon's git.ts adds only a
// terminal-backed GitRunner (terminalGit) and its commit identity on top of these.

// Initialize a fresh git repo in `dir` (created if absent). `separateGitDir` keeps the real git dir outside the
// worktree (the in-tree .git becomes a pointer file), so workspace accidents can't destroy history.
export const gitInit = async (dir: string, separateGitDir?: string, git: GitRunner = defaultGit): Promise<void> => {
    await mkdir(dir, { recursive: true });
    if (separateGitDir !== undefined) {
        // Git creates the git dir itself but not its parents (fresh /history volume has no gits/).
        await mkdir(dirname(separateGitDir), { recursive: true });
    }
    await git(dir, ["init", "-q", "--initial-branch=main", ...(separateGitDir !== undefined ? [`--separate-git-dir=${separateGitDir}`] : [])]);
};

export interface GitCloneOptions {
    readonly branch?: string;
    // "Authorization: Basic …" rides a -c http.extraheader flag for private-repo clones, so the credential
    // never lands in the URL, .git/config, or git's stderr.
    readonly authHeader?: string;
    // Keep the real git dir outside the worktree (the in-tree .git becomes a pointer file), see gitInit.
    readonly separateGitDir?: string;
}

// Clone a repo into <parentDir>/<name>. Push/pull auth rides on the URL or the credentials the host already
// holds, no token passes through the platform. The caller validates `name`.
export const gitClone = async (
    parentDir: string,
    name: string,
    cloneUrl: string,
    options?: GitCloneOptions,
    git: GitRunner = defaultGit,
): Promise<void> => {
    if (options?.separateGitDir !== undefined) {
        // Git creates the git dir itself but not its parents (fresh /history volume has no gits/).
        await mkdir(dirname(options.separateGitDir), { recursive: true });
    }
    await git(parentDir, [
        ...(options?.authHeader !== undefined ? ["-c", `http.extraheader=${options.authHeader}`] : []),
        "clone",
        ...(options?.branch !== undefined ? ["--branch", options.branch] : []),
        ...(options?.separateGitDir !== undefined ? [`--separate-git-dir=${options.separateGitDir}`] : []),
        cloneUrl,
        name,
    ]);
};

const porcelainFiles = (stdout: string): string[] =>
    stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

export interface GitStatus {
    readonly branch: string;
    readonly dirty: boolean;
    // Porcelain entries (e.g. " M src/app.ts"), one per changed path. Mutable to match the wire schema
    // (GitStatusSchema) the daemon's status route returns directly.
    readonly files: string[];
}

export const gitStatus = async (dir: string, git: GitRunner = defaultGit): Promise<GitStatus> => {
    // Two independent read-only spawns, run them concurrently (this backs the daemon's polled status route).
    const [branchOut, statusOut] = await Promise.all([git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), git(dir, ["status", "--porcelain"])]);
    const branch = branchOut.stdout.trim();
    const files = porcelainFiles(statusOut.stdout);
    return { branch, dirty: files.length > 0, files };
};

/* STAGE THE WHOLE TREE, AND SURVIVE THE ONE PATH GIT REFUSES TO STAGE.
 *
 * `add -A` is all-or-nothing by default: it DIES on the first path it cannot record and stages nothing at all.
 * The path that turns up in this product is an embedded repo with NO COMMIT — an agent that ran `git init` in a
 * new directory and has not committed inside it yet. A repo dir is staged as a gitlink, a gitlink is a HEAD sha,
 * and an unborn HEAD has none, so git says "'x/' does not have a commit checked out" and aborts the run, taking
 * every unrelated edit in the tree down with it.
 *
 * That is not a corner: every step that preserves an agent's worktree stages through here (the turn anchor, the
 * turn-start rebase, the land, the archive), so one uncommitted `git init` froze a whole conversation. The land
 * threw, the card was stamped `error` with git's sentence on it, the turn anchor was lost, and pressing continue
 * reproduced all of it, because nothing about pressing continue commits the repo the agent left unborn.
 *
 * `--ignore-errors` turns the death into a SKIP: the offending path stays out of the index, everything else is
 * staged, and the exit code drops from 128 to 1. So exit 1 means "some paths were skipped", which is exactly the
 * outcome this wants and the only one it swallows. Anything else — 128 for a dir that is not a repo, a locked
 * index, a broken object store — is a genuine fault and still throws, because a remainder that could not be
 * staged AT ALL must never pass for one that was clean.
 *
 * The embedded-repo advice is off because it is addressed to nobody here: nested repos are ordinary in this
 * workspace (every repo of a composition is one) and root drops the gitlinks it stages moments later, while the
 * hint printed a twelve-line submodule tutorial into the daemon log on every land. */
export const gitStageAll = async (dir: string, git: GitRunner = defaultGit): Promise<void> => {
    try {
        await git(dir, ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
    } catch (error) {
        if ((error as { code?: unknown }).code !== 1) {
            throw error;
        }
    }
};

// Stage everything and commit; returns false (no commit) when there was nothing to commit, so callers can
// commit freely without erroring on a no-op. The gate is the INDEX after staging, never the worktree: `git
// status` also reports dirt that `add -A` cannot stage, modified content inside a NESTED repo, whose gitlink
// moves only when that repo's own HEAD does, and committing on that verdict fails outright ("no changes added
// to commit"). Credentials never touch this, push auth rides on the remote the runner configured when it
// cloned.
export const gitCommitAll = async (
    dir: string,
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    await gitStageAll(dir, git);
    // Unborn HEAD included: with no commit to diff against, `--cached` falls back to the empty tree, so a
    // repo's first commit reports its staged files rather than reading as nothing to do.
    if ((await git(dir, ["diff", "--cached", "--name-only", "-z"])).stdout === "") {
        return false;
    }
    /* `--no-verify` because this commit is PROVENANCE, not authorship: it preserves an agent's worktree state on
     * its own branch so a land has something to take a delta from, and its message is machine-written from the
     * agent's title. A repo whose commit-msg hook enforces Conventional Commits (this one's does) rejected every
     * such message that didn't happen to parse, and since the hook's exit code propagates out of `git commit`,
     * that refusal surfaced as a 500 from /agents/{id}/land with the real reason buried in the daemon log. The
     * user's commit policy governs the user's commits; it cannot be allowed to make an agent's work unlandable.
     */
    await git(dir, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--no-verify", "-m", message]);
    return true;
};

// Detached checkout of any ref, branch, tag, or commit sha, after a full clone (a shallow clone can't reach
// an arbitrary sha, so clones that may be ref-pinned stay full).
export const gitCheckout = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["checkout", "--detach", "-q", ref]);
};

// The checkout's short HEAD sha, the version identity a plugin capability reports.
export const gitHead = async (dir: string, git: GitRunner = defaultGit): Promise<string> =>
    (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();

// The full 40-character HEAD sha, what an extension revert writes back into the capability's `ref`, whose
// schema (rightly) refuses the abbreviated form above.
export const gitFullHead = async (dir: string, git: GitRunner = defaultGit): Promise<string> => (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

// The repo's tracked files (git ls-files), so the UI can render the source tree without node_modules/build
// noise. Untracked-but-present files are intentionally excluded, they surface through status instead.
export const gitListFiles = async (dir: string, git: GitRunner = defaultGit): Promise<string[]> =>
    (await git(dir, ["ls-files"])).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

export type GitSyncResult =
    | { readonly status: "updated"; readonly behind: number; readonly head: string }
    | { readonly status: "current" }
    | { readonly status: "dirty"; readonly behind: number }
    | { readonly status: "diverged"; readonly ahead: number; readonly behind: number }
    | { readonly status: "no-remote" };

// Bring `dir` up to its upstream, but only when that's safe: fetch origin, then fast-forward ONLY a clean tree
// that is strictly behind. A dirty tree (agent mid-edit), unpushed local commits (diverged), or a detached /
// upstream-less checkout are left exactly as-is and reported, sync never clobbers work. Fetch auth rides on
// `origin` just as the daemon's push does, so wherever push works this works. Git errors (e.g. an unreachable
// remote) propagate;
// the turn-level caller (syncWorkspaceRepos) catches per-repo so one repo can't fail the turn.
export const gitSync = async (dir: string, git: GitRunner = defaultGit): Promise<GitSyncResult> => {
    const remotes = (await git(dir, ["remote"])).stdout.split("\n").map((line) => line.trim());
    if (!remotes.includes("origin")) {
        return { status: "no-remote" };
    }
    await git(dir, ["fetch", "--quiet", "origin"]);
    // No upstream (detached HEAD / a ref-pinned or never-pushed branch) ⇒ nothing to track. Real git exits
    // non-zero here; the injectable test fake returns "", both mean "skip".
    const upstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
        (r) => r.stdout.trim(),
        () => "",
    );
    if (upstream === "") {
        return { status: "no-remote" };
    }
    // `--left-right --count @{u}...HEAD`: left = commits on the upstream but not HEAD (behind), right = on HEAD
    // but not the upstream (ahead).
    const [behind = 0, ahead = 0] = (await git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])).stdout.trim().split(/\s+/).map(Number);
    if (behind === 0) {
        return { status: "current" };
    }
    if (porcelainFiles((await git(dir, ["status", "--porcelain"])).stdout).length > 0) {
        return { status: "dirty", behind };
    }
    if (ahead > 0) {
        return { status: "diverged", ahead, behind };
    }
    await git(dir, ["merge", "--ff-only", "--quiet", "@{u}"]);
    return { status: "updated", behind, head: await gitHead(dir, git) };
};
