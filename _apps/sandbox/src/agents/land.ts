import { access } from "node:fs/promises";
import { join } from "node:path";
import type { LandResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { changedFiles } from "../git/changes.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import type { PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

// Land a conversation's work into the main tree, per repo of its composition: commit the worktree's dirty
// state onto agent/<id> (an agent-authored WIP commit — nothing is ever lost), guard against overlapping
// dirty paths in the main checkout, then `git merge` the branch (ff when main hasn't moved — the common
// case). A merge conflict aborts cleanly and reports its paths; the worktree keeps everything, so the user
// can discard, keep working, or land again. Deliberately NON-transactional across repos: repos that merged
// stay merged, conflicted ones are reported — `landed` is true only when nothing conflicted. The worktree
// survives a land, so follow-up turns commit further onto the branch and the next land merges the delta.
// Rebase-before-land rejected for v1: `merge --abort` is crash-safe; mid-rebase recovery is not.

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

const withAgentAuthor = ["-c", `user.name=${AGENT_GIT_AUTHOR.name}`, "-c", `user.email=${AGENT_GIT_AUTHOR.email}`];

export const landAgent = async (worktrees: AgentWorktrees, entry: PersistedAgent, git: GitRunner = defaultGit): Promise<LandResult> => {
    const conflicts: { repo: string; paths: string[] }[] = [];
    for (const { repo, base } of entry.repos) {
        await worktrees.withRepoLock(repo, async () => {
            const worktree = worktrees.worktreeDir(entry.id, repo);
            if (!(await exists(worktree))) {
                return;
            }
            const main = worktrees.mainDir(repo);
            if (!(await exists(join(main, ".git")))) {
                // The main checkout vanished — nothing to merge into; surfaced, not silently skipped.
                conflicts.push({ repo, paths: [] });
                return;
            }
            // 1. Preserve the worktree's uncommitted state as an agent-authored commit on its branch.
            if ((await changedFiles(worktree, git)).changes.length > 0) {
                await git(worktree, ["add", "-A"]);
                await git(worktree, [...withAgentAuthor, "commit", "-q", "-m", `Agent: ${entry.title ?? entry.id}`]);
            }
            const tip = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
            if (tip === base) {
                return; // Nothing to land for this repo.
            }
            // 2. Dirty-main guard: a merge would clobber uncommitted main-tree edits on the same paths (git's
            // own untracked/modified-overwrite aborts included) — report them instead of attempting. Disjoint
            // dirty paths are fine; the merge leaves them alone.
            const changedSinceBase = (await git(main, ["diff", "--name-only", "-z", base, tip])).stdout.split("\0").filter((path) => path !== "");
            const mainDirty = new Set<string>();
            for (const change of (await changedFiles(main, git)).changes) {
                mainDirty.add(change.path);
                if (change.from !== undefined) {
                    mainDirty.add(change.from);
                }
            }
            const overlap = changedSinceBase.filter((path) => mainDirty.has(path));
            if (overlap.length > 0) {
                conflicts.push({ repo, paths: overlap });
                return;
            }
            // 3. Merge; a conflict aborts back to a clean main tree and reports the unmerged paths.
            try {
                await git(main, [...withAgentAuthor, "merge", "--no-edit", entry.branch]);
            } catch {
                const unmerged = (await git(main, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout
                    .split("\0")
                    .filter((path) => path !== "");
                await git(main, ["merge", "--abort"]).catch(() => undefined);
                conflicts.push({ repo, paths: unmerged });
            }
        });
    }
    return { landed: conflicts.length === 0, ...(conflicts.length > 0 ? { conflicts } : {}) };
};
