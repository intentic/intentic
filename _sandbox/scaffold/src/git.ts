import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultGit, type GitRunner } from "./exec.js";

// Generic git verbs over the injectable GitRunner, shared by the CLI (init/scaffold-app/adopt) and the sandbox daemon.
// The daemon's own git.ts adds only a terminal-backed GitRunner and commit identity on top.

// Initializes a fresh repo in `dir`; `separateGitDir` keeps the real git dir outside the worktree as a pointer file.
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
    // Sent via `-c http.extraheader`, not the URL, so the credential never lands in .git/config or stderr.
    readonly authHeader?: string;
    // Real git dir outside the worktree; the in-tree .git becomes a pointer file.
    readonly separateGitDir?: string;
}

// Clones into `<parentDir>/<name>`; push/pull auth rides the URL or host credentials, never the platform. Caller
// validates `name`.
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
    // Porcelain entries (e.g. ' M src/app.ts'); mutable to match the wire schema (GitStatusSchema).
    readonly files: string[];
}

export const gitStatus = async (dir: string, git: GitRunner = defaultGit): Promise<GitStatus> => {
    // Two independent read-only spawns; run concurrently since this backs a polled status route.
    const [branchOut, statusOut] = await Promise.all([git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), git(dir, ["status", "--porcelain"])]);
    const branch = branchOut.stdout.trim();
    const files = porcelainFiles(statusOut.stdout);
    return { branch, dirty: files.length > 0, files };
};

// `add -A --ignore-errors` skips a path it cannot stage (an embedded repo with no commit) instead of failing the whole
// add; exit 1 means paths were skipped and is swallowed, anything else still throws.
export const gitStageAll = async (dir: string, git: GitRunner = defaultGit): Promise<void> => {
    try {
        await git(dir, ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
    } catch (error) {
        if ((error as { code?: unknown }).code !== 1) {
            throw error;
        }
    }
};

// Returns false (no commit) when the index has nothing staged, which can differ from `git status` for a nested repo's
// own changes; push auth rides the remote configured at clone.
export const gitCommitAll = async (
    dir: string,
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    await gitStageAll(dir, git);
    // Unborn HEAD included: with nothing to diff against, --cached falls back to the empty tree.
    if ((await git(dir, ["diff", "--cached", "--name-only", "-z"])).stdout === "") {
        return false;
    }
    // --no-verify: provenance not authorship, so the user's commit-msg hooks must not block an agent's land.
    await git(dir, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--no-verify", "-m", message]);
    return true;
};

// Detached checkout of any ref/branch/tag/sha; needs a full clone since a shallow one can't reach an arbitrary sha.
export const gitCheckout = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["checkout", "--detach", "-q", ref]);
};

// Short HEAD sha; the version identity a plugin capability reports.
export const gitHead = async (dir: string, git: GitRunner = defaultGit): Promise<string> =>
    (await git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();

// Full 40-character HEAD sha; an extension revert writes this into the capability's `ref` (schema refuses the short
// form).
export const gitFullHead = async (dir: string, git: GitRunner = defaultGit): Promise<string> => (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();

// Tracked files only (git ls-files), so the UI tree skips node_modules/build noise; untracked files surface via status.
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

// Fetches origin and fast-forwards only a clean tree strictly behind; a dirty, diverged, or upstream-less repo is left
// as-is and reported, never clobbered. Git errors propagate; the caller catches per-repo.
export const gitSync = async (dir: string, git: GitRunner = defaultGit): Promise<GitSyncResult> => {
    const remotes = (await git(dir, ["remote"])).stdout.split("\n").map((line) => line.trim());
    if (!remotes.includes("origin")) {
        return { status: "no-remote" };
    }
    await git(dir, ["fetch", "--quiet", "origin"]);
    // No upstream means nothing to track; real git exits non-zero, the test fake returns '', both mean skip.
    const upstream = await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(
        (r) => r.stdout.trim(),
        () => "",
    );
    if (upstream === "") {
        return { status: "no-remote" };
    }
    // --left-right counts: left is upstream-not-HEAD (behind), right is HEAD-not-upstream (ahead).
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
