import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, gitInit, type GitRunner } from "@intentic/base/git";
import { AGENT_GIT_AUTHOR } from "../../git-identity.js";
import { repoGitDir, syncRootExcludes } from "../../workspace/layout/git-layout.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import { headSha } from "../changes/changes.js";
import { commitWorktreeRemainder } from "./root-repo.js";

// A project folder as a repo in the daemon's own layout, like one it cloned or created: a project sandbox's one folder
// (system/project-dir.ts), or each folder attached to a projects host (system/projects-registry.ts). It gets its git
// dir on /history and a `.git` pointer in the folder, so the Changes review, history and isolated turns read it as they
// read any repo. The owner's own history never arrives, since file sync leaves every `.git` out, so this repo arrives
// unborn and is given its first commit here.
//
// THAT FIRST COMMIT IS WHAT MAKES THE FOLDER A REPOSITORY RATHER THAN A HOLE. An unborn HEAD has nothing to branch
// from, so a conversation's composition leaves such a repo out (conversations/worktrees/worktrees.ts): its checkout
// never holds the folder, the root repo excludes the path as it excludes every repo, and so anything an agent writes
// there reaches no branch, no review, no land and no board. Left to the owner it would never be taken, since nobody
// commits a folder they only ever see through sync, and these commits are the daemon's own bookkeeping either way:
// the git bridge refuses a project pairing (devices/machine sync/git-bridge.ts), so nothing here ever reaches the
// owner's own `.git`, and landed work goes to their folder as files (conversations/land/project-delivery.ts).

// Git-dir config the daemon writes on a project folder's repo, read wherever only the repo's directory is at hand: the
// repo is a mirror of a folder file sync fills, so its HEAD is kept current by the daemon at turn and land boundaries
// whatever the owner's version rule says (conversations/land/version-landed.ts). Lives in the git dir on /history,
// which file sync never carries, so the owner's own folder never sees it.
export const PROJECT_FOLDER_CONFIG = "intentic.projectFolder";

// Whether the repo at `dir` is a project folder's mirror. Exit 1 is git's answer for an unset key, which is every other
// repo; anything else (a directory git cannot read as a repo) is thrown for the caller, which skips that repo.
export const isProjectFolderRepo = async (dir: string, git: GitRunner = defaultGit): Promise<boolean> => {
    try {
        return (await git(dir, ["config", "--local", "--get", PROJECT_FOLDER_CONFIG])).stdout.trim() === "true";
    } catch (error) {
        // SAFETY: the git runner rejects with the child's exit status as a numeric `code`; any other shape reads undefined.
        if ((error as { code?: unknown }).code === 1) {
            return false;
        }
        throw error;
    }
};

// What this boot did, for its log line; "already a repo" is the steady state that changed nothing.
export type ProjectRepoOutcome = "created" | "pointer restored" | "already a repo" | "left to relocation" | "first commit taken";

const initialSubject = (name: string): string => `Your ${name} folder, as this sandbox received it`;

// Gives the repo a HEAD if it has none, and says whether it had to. Whatever file sync has delivered so far goes in;
// a folder it has not reached yet gets an empty commit, since a born HEAD is the whole point and the files arrive at
// the next boundary like any later change (conversations/land/version-landed.ts). Asked on every boot, so a repo an
// older sandbox left unborn is born the first time this one starts.
const bornHead = async (workspace: WorkspacePaths, name: string, dir: string, git: GitRunner): Promise<boolean> => {
    // Marked every boot, so a repo an older sandbox made is recognized from the first boot of one that reads the mark.
    await git(dir, ["config", "--local", PROJECT_FOLDER_CONFIG, "true"]);
    if ((await headSha(dir, git)) !== undefined) {
        return false;
    }
    const subject = initialSubject(name);
    if (!(await commitWorktreeRemainder(name, dir, subject, workspace.root, git))) {
        await git(dir, ["-c", `user.name=${AGENT_GIT_AUTHOR.name}`, "-c", `user.email=${AGENT_GIT_AUTHOR.email}`, "commit", "-q", "--allow-empty", "-m", subject]);
    }
    return true;
};

export const ensureProjectRepo = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    name: string,
    git: GitRunner = defaultGit,
): Promise<ProjectRepoOutcome> => {
    const dir = join(workspace.root, name);
    const entry = await lstat(join(dir, ".git")).catch(undefinedIfMissing);
    // An in-tree git dir is the repoGitDirs step's to move onto /history, which runs after this one; its HEAD is left
    // to the next boot, which finds a pointer here like any other repo's.
    if (entry !== undefined) {
        return entry.isDirectory() ? "left to relocation" : (await bornHead(workspace, name, dir, git)) ? "first commit taken" : "already a repo";
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
    // it would take the project's files into the workspace's own repo. Before the first commit below, which would
    // otherwise race the root baseline for the same files.
    await syncRootExcludes(historyRoot, await discoverRepos(workspace.root));
    await bornHead(workspace, name, dir, git);
    return restoring ? "pointer restored" : "created";
};
