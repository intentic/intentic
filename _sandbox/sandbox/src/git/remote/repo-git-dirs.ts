import { cp, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { repoGitDir } from "../../history/history.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";

// No git dir lives under /work, so an isolated turn's worktree can stand in for the whole workspace root. Converges
// every repo onto this shape on each boot; a repo already converged costs nothing.

// Shape of this repo's `.git`: a file is already the target shape, a dir must move; anything else (missing, dangling
// symlink) is not handled here.
const gitEntryKind = async (repoDir: string): Promise<"dir" | "file" | undefined> => {
    const stats = await lstat(join(repoDir, ".git")).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    return stats.isDirectory() ? "dir" : "file";
};

// `core.worktree` is an absolute path shared by every worktree; pinned to /work/<repo> it would misdirect an isolated
// turn's own worktree to the main checkout. Unset, git resolves the worktree relative to the caller instead.
const unpinWorktree = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exits non-zero when the key was already absent; that's the steady state, not a failure.
    await git(repoDir, ["config", "--unset", "core.worktree"]).catch(() => undefined);
};

// core.bare lives in the git dir's shared config: true blocks the main checkout while linked worktrees still work,
// which hides it. Every repo here has a real directory, so `false` is always correct here.
const unbare = async (repoDir: string, git: GitRunner): Promise<void> => {
    // Exits non-zero when the key is absent; that already matches the default (false).
    const current = await git(repoDir, ["config", "--get", "core.bare"]).catch(() => undefined);
    if (current?.stdout.trim() !== "true") {
        return;
    }
    await git(repoDir, ["config", "core.bare", "false"]);
};

const relocateOne = async (repo: string, workspace: WorkspacePaths, historyRoot: string, logger: Logger, git: GitRunner): Promise<void> => {
    const repoDir = join(workspace.root, repo);
    if ((await gitEntryKind(repoDir)) !== "dir") {
        return;
    }
    const target = repoGitDir(historyRoot, repo);
    if ((await lstat(target).catch(() => undefined)) !== undefined) {
        // Target already has a git dir; moving would destroy one of them, so this repo just keeps its in-tree git dir.
        logger.warn({ repo, target }, "git dirs: target already occupied, repo left with an in-tree git dir");
        return;
    }
    // Copies then swaps, not renames, since /work and /history are separate mounts (rename would fail EXDEV). A crash
    // before the pointer write leaves the original `.git` untouched; `dereference: false` preserves git's own symlinks.
    const entry = join(repoDir, ".git");
    await cp(entry, target, { recursive: true, dereference: false });
    // Removed so the pointer file can take this name; a failure here restores the copy under its original name.
    await rm(entry, { recursive: true, force: true });
    await writeFile(entry, `gitdir: ${target}\n`).catch(async (error: unknown) => {
        await cp(target, entry, { recursive: true, dereference: false });
        await rm(target, { recursive: true, force: true });
        throw error;
    });
    // Repairs every worktree's pointer and backlink so none lose their checkout when the git dir moves.
    await git(repoDir, ["worktree", "repair"]).catch((error: unknown) => logger.warn({ err: error, repo }, "git dirs: worktree repair failed"));
    logger.info({ repo, target }, "git dirs: relocated in-tree git dir off the workspace root");
};

// Converges every repo onto an out-of-tree git dir, unpinned and non-bare. Best-effort: one repo's failure costs only
// its own isolation, never the boot; repairs run on every repo so a stale pin can't persist.
export const ensureRepoGitDirs = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    logger: Logger,
    git: GitRunner = defaultGit,
): Promise<void> => {
    for (const repo of await discoverRepos(workspace.root)) {
        await relocateOne(repo, workspace, historyRoot, logger, git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "git dirs: relocation failed, repo keeps its in-tree git dir"),
        );
        await unpinWorktree(join(workspace.root, repo), git);
        await unbare(join(workspace.root, repo), git).catch((error: unknown) =>
            logger.warn({ err: error, repo }, "git dirs: could not clear core.bare, the main checkout stays unreadable to git"),
        );
    }
};
