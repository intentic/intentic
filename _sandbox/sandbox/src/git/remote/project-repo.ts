import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, gitInit, type GitRunner } from "@intentic/scaffold";
import { repoGitDir, syncRootExcludes } from "../../workspace/layout/git-layout.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";

// A project folder as a repo in the daemon's own layout, like one it cloned or created: a project sandbox's one folder
// (system/project-dir.ts), or each folder attached to a projects host (system/projects-registry.ts). It gets its git
// dir on /history and a `.git` pointer in the folder, so the Changes review, history and isolated turns read it as they
// read any repo. The owner's own history never arrives, since file sync leaves every `.git` out, so this repo starts
// unborn. Nothing is committed here: the folder may still be empty or half-synced when this runs, and its first commit
// is the snapshot machinery's, as for any repo.

// What this boot did, for its log line; only the first two changed anything.
export type ProjectRepoOutcome = "created" | "pointer restored" | "already a repo" | "left to relocation";

export const ensureProjectRepo = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    name: string,
    git: GitRunner = defaultGit,
): Promise<ProjectRepoOutcome> => {
    const dir = join(workspace.root, name);
    const entry = await lstat(join(dir, ".git")).catch(undefinedIfMissing);
    // An in-tree git dir is the repoGitDirs step's to move onto /history, which runs next; a pointer file is a repo
    // already, whatever it names.
    if (entry !== undefined) {
        return entry.isDirectory() ? "left to relocation" : "already a repo";
    }
    const gitDir = repoGitDir(historyRoot, name);
    // A git dir that lost its pointer (an agent's `rm .git`) holds the folder's history so far; a fresh init would
    // orphan it.
    const restoring = await pathExists(gitDir);
    if (restoring) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, ".git"), `gitdir: ${gitDir}\n`);
    } else {
        // Makes the folder too when file sync has not delivered it yet, so the repo stands before its first file does.
        await gitInit(dir, gitDir, git);
    }
    // Root's excludes were synced before this folder was a repo; left stale, the baseline and every root snapshot after
    // it would take the project's files into the workspace's own repo.
    await syncRootExcludes(historyRoot, await discoverRepos(workspace.root));
    return restoring ? "pointer restored" : "created";
};
