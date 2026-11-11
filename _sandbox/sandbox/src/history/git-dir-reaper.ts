import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { checkoutsOf, convergeGitDirs, type GitDirPointer, reapGitDir } from "../workspace/layout/git-dir-owners.js";
import { hasGitEntry, isValidRepoId } from "../workspace/layout/repo-discovery.js";
import type { HistoryGitRunner } from "./history-git.js";

// The history cycle's care of /history/gits, split out of history.ts: heal a pointer an agent deleted, reap the git
// dir of a repo that was deleted, and never reap one a checkout under /work still leads into (git-dir-owners.ts says
// who that is, and gives copied and moved checkouts dirs of their own first).

// Cheap gate before deletionState: ignored entries (node_modules, dist, .git pointer) survive a real delete, so
// emptiness alone doesn't prove one.
const looksEmptied = async (worktree: string): Promise<boolean> => {
    const entries = (await readdir(worktree, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    return entries.every((entry) => entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name));
};

// "deleted" means the index names files and none exist on disk; an empty index is "fresh", not deleted. Exits early on
// the first file found on disk.
const deletionState = async (git: HistoryGitRunner, gitDir: string, worktree: string): Promise<"live" | "fresh" | "deleted"> => {
    const { stdout } = await git(["ls-files", "-z"], { cwd: worktree, env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree } });
    const paths = stdout.split("\0").filter((path) => path !== "");
    if (paths.length === 0) {
        return "fresh";
    }
    for (const path of paths) {
        if (await pathExists(join(worktree, path))) {
            return "live";
        }
    }
    return "deleted";
};

export interface GitDirReaperOptions {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly logger: Logger;
    readonly git: HistoryGitRunner;
    // How long an emptied checkout whose pointer survives waits before its dir is reaped: a big clone can be briefly
    // empty.
    readonly graceMs: number;
}

export interface GitDirReaper {
    // One pass over the discovered repos; true when a pointer was written or removed, so discovery may have changed.
    readonly heal: (repos: readonly string[]) => Promise<boolean>;
}

export const createGitDirReaper = (options: GitDirReaperOptions): GitDirReaper => {
    const { workspaceRoot, historyRoot, logger, git } = options;
    const gitsRoot = join(historyRoot, "gits");
    const emptySince = new Map<string, number>();
    // Entries kept for another checkout, said once each rather than every cycle.
    const keptSaid = new Set<string>();
    const blockedSaid = new Set<string>();

    // A checkout whose tracked files are gone: reaped at once when its pointer went too, else after a grace cycle,
    // and then the pointer goes with it. True when the pointer was removed.
    const emptied = async (entry: string, worktree: string, hasPointer: boolean): Promise<boolean> => {
        if (!hasPointer) {
            emptySince.delete(entry);
            await reapGitDir(historyRoot, entry, logger, "worktree emptied");
            return false;
        }
        const since = emptySince.get(entry);
        if (since === undefined) {
            emptySince.set(entry, Date.now());
            return false;
        }
        if (Date.now() - since < options.graceMs) {
            return false;
        }
        emptySince.delete(entry);
        await reapGitDir(historyRoot, entry, logger, "worktree emptied");
        await rm(join(worktree, ".git"), { force: true });
        return true;
    };

    // One git dir: kept while another checkout leads into it, reaped when its folder is gone or holds another
    // repository, its pointer rewritten when only that was deleted. True when a pointer was written or removed.
    const healEntry = async (entry: string, id: string, pointers: readonly GitDirPointer[]): Promise<boolean> => {
        const users = checkoutsOf(pointers, entry, id);
        if (users.length > 0) {
            emptySince.delete(entry);
            if (!keptSaid.has(entry)) {
                keptSaid.add(entry);
                logger.info({ repo: id, users: users.map((user) => user.repo) }, "history: kept a repo's git dir, another checkout still uses it");
            }
            return false;
        }
        keptSaid.delete(entry);
        const worktree = join(workspaceRoot, id);
        if (!(await pathExists(worktree))) {
            emptySince.delete(entry);
            await reapGitDir(historyRoot, entry, logger, "worktree deleted");
            return false;
        }
        const hasPointer = await hasGitEntry(worktree);
        if (hasPointer && !pointers.some((pointer) => pointer.repo === id && pointer.entry === entry)) {
            // Its `.git` leads somewhere else now: an in-tree clone made over the old folder, or a pointer to another dir.
            emptySince.delete(entry);
            await reapGitDir(historyRoot, entry, logger, "its folder now holds another repository");
            return false;
        }
        const gitDir = join(gitsRoot, entry);
        if (!(await looksEmptied(worktree)) || (await deletionState(git, gitDir, worktree)) !== "deleted") {
            emptySince.delete(entry);
            if (hasPointer) {
                return false;
            }
            await writeFile(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
            return true;
        }
        return emptied(entry, worktree, hasPointer);
    };

    const heal = async (repos: readonly string[]): Promise<boolean> => {
        const { pointers } = await convergeGitDirs({ workspaceRoot, historyRoot, logger, said: blockedSaid }, repos);
        let rediscover = false;
        for (const entry of (await readdir(gitsRoot).catch(undefinedIfMissing)) ?? []) {
            const id = decodeURIComponent(entry);
            // Skips non-repo-id entries: other tools can drop state here, and it must not be treated as a deleted repo.
            if (id === "root" || !isValidRepoId(id)) {
                continue;
            }
            try {
                rediscover = (await healEntry(entry, id, pointers)) || rediscover;
            } catch (error) {
                logger.warn({ err: error, repo: id }, "history: git-dir heal failed");
            }
        }
        return rediscover;
    };

    return { heal };
};
