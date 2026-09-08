import { join } from "node:path";
import type { RepoBase } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { branchSha } from "../agents/land/agent-refs.js";

// Which repos a finished step actually left work in: a handover names a branch (`agent/<conversation>`) so the next
// step reviews real changes, but the name is derived and can be false (partial touch, unclean turn, no diff vs base).
// Resolved before handoff; dropping is the safe direction, and an empty result never fails the step.

export interface HandoverBranch {
    readonly repo: string;
    readonly base: string;
    readonly branch: string;
}

// `root` is the workspace itself; anything else is the repo's root-relative directory, the mapping worktrees.ts also
// uses.
const mainDirOf = (root: string, repo: string): string => (repo === "root" ? root : join(root, repo));

// Whether the branch carries anything the base does not, the reviewer's own diff question. A throw here keeps the
// branch, unlike the rest of the module: existence is already proven, so failure means hard to measure, not missing.
const carriesCommits = async (dir: string, base: string, tip: string, git: GitRunner): Promise<boolean> => {
    try {
        const { stdout } = await git(dir, ["rev-list", "--count", `${base}..${tip}`]);
        return Number(stdout.trim()) > 0;
    } catch {
        return true;
    }
};

// Repos that genuinely hold `branch`, in the given order, checked in parallel (one `for-each-ref`, one `rev-list` per
// repo at most). Dropped silently: absence usually means the step never touched that repo.
export const resolvedBranches = async (
    root: string,
    repos: readonly RepoBase[],
    branch: string,
    git: GitRunner = defaultGit,
): Promise<readonly HandoverBranch[]> => {
    const checked = await Promise.all(
        repos.map(async ({ repo, base }): Promise<HandoverBranch | undefined> => {
            const dir = mainDirOf(root, repo);
            // Undefined means neither the live nor parked spelling of the branch exists in this repo.
            const tip = await branchSha(dir, branch, git).catch(() => undefined);
            if (tip === undefined) {
                return undefined;
            }
            return (await carriesCommits(dir, base, tip, git)) ? { repo, base, branch } : undefined;
        }),
    );
    return checked.filter((entry): entry is HandoverBranch => entry !== undefined);
};
