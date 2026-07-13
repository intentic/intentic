import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGit, gitInit, type GitRunner } from "@intentic/scaffold";
import { repoGitDir, ROOT_EXCLUDES } from "../history/history.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { AGENT_GIT_AUTHOR } from "./git.js";

// The /work workspace repo ("root"): the ENTIRE workspace is under version control, not just the nested
// repositories — the Changes review commits/discards root files like any repo's. The git dir lives on
// /history (agent-tamper-proof, the nested repos' --separate-git-dir pattern); the in-worktree /work/.git is
// a pointer file this ensure (and history's healGitPointer) rewrites if the agent deletes it. Idempotent and
// boot-cheap: init happens once, the pointer + exclude list re-converge on every boot.

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Returns true only when this boot freshly `gitInit`ed the repo — the caller then takes the baseline commit
// (commitRootBaseline) AFTER converging its /work-owned files, so those files land inside the baseline.
export const ensureRootRepo = async (workspace: WorkspacePaths, historyRoot: string, git: GitRunner = defaultGit): Promise<boolean> => {
    const gitDir = repoGitDir(historyRoot, "root");
    const fresh = !(await exists(gitDir));
    if (fresh) {
        await gitInit(workspace.root, gitDir, git);
    } else if (!(await exists(join(workspace.root, ".git")))) {
        await writeFile(join(workspace.root, ".git"), `gitdir: ${gitDir}\n`);
    }
    // The same list as the shadow history's root scope, in $GIT_DIR/info/exclude — outside /work, so the
    // agent can't edit the rules. Rewritten every boot (a daemon update may change the list) and BEFORE the
    // baseline commit, so it can never capture repositories/, credentials, or junk.
    await writeFile(join(gitDir, "info", "exclude"), `${ROOT_EXCLUDES.join("\n")}\n`);
    if (fresh) {
        // Repeat status scans over /work stay stat-cheap.
        await git(workspace.root, ["config", "core.untrackedCache", "true"]);
    }
    return fresh;
};

// The baseline "Initialize workspace" commit — run once, on a fresh sandbox, AFTER the daemon has converged its
// /work-owned files (the drafts skill, baked-tool skills). Whatever exists becomes committed state so the
// Changes review starts clean and daemon-owned files don't surface as a phantom add. --allow-empty keeps HEAD
// born even on an empty workspace — no unborn-HEAD special case for root.
export const commitRootBaseline = async (workspace: WorkspacePaths, git: GitRunner = defaultGit): Promise<void> => {
    await git(workspace.root, ["add", "-A"]);
    await git(workspace.root, [
        "-c",
        `user.name=${AGENT_GIT_AUTHOR.name}`,
        "-c",
        `user.email=${AGENT_GIT_AUTHOR.email}`,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Initialize workspace",
    ]);
};
