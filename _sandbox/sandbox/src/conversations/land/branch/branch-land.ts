import type { WorktreePlacement } from "../../registry/agents-store.js";
import type { BranchCheckouts } from "../../worktrees/branches/branch-checkouts.js";

// Branch landings use the same uncommitted patch application as shared /work, with the selected branch checkout as
// the destination. Each repository needs an explicit branch destination before any write begins.

export interface BranchLine {
    readonly branch: string;
    readonly dir: string;
}
export type BranchLines = ReadonlyMap<string, BranchLine>;
export const NO_BRANCH_LINES: BranchLines = new Map();

/** The checkout a repo's land is measured against and written into: its branch's, else the main tree's. */
export const lineDirOf = (worktrees: { readonly mainDir: (repo: string) => string }, lines: BranchLines, repo: string): string =>
    lines.get(repo)?.dir ?? worktrees.mainDir(repo);

/**
 * Each of the conversation's repos started from a branch, its checkout refreshed while preserving local work;
 * before any repo lock is taken, which the refresh takes itself. Empty, at no cost, for every other conversation.
 */
export const branchLinesOf = async (
    deps: { readonly branchCheckouts: Pick<BranchCheckouts, "refresh"> },
    placement: Pick<WorktreePlacement, "branches" | "repos"> | undefined,
): Promise<BranchLines> => {
    const started = (placement?.branches ?? []).filter(({ repo }) => placement?.repos.some((composed) => composed.repo === repo) === true);
    if (started.length === 0) {
        return NO_BRANCH_LINES;
    }
    const lines = new Map<string, BranchLine>();
    for (const { repo, branch } of started) {
        lines.set(repo, { branch, dir: await deps.branchCheckouts.refresh(repo, branch) });
    }
    return lines;
};

/** The branch named by a repository's landing destination. */
export interface BranchOnto {
    readonly branch: string;
}

export const branchOnto = (line: BranchLine | undefined): BranchOnto | undefined =>
    line === undefined ? undefined : { branch: line.branch };

/** A branch commit never falls back to writing a repository's shared checkout. Called before any planned write. */
export const assertBranchDestination = (placement: Pick<WorktreePlacement, "branches">, onto: BranchOnto | undefined, repo: string): void => {
    const started = placement.branches ?? [];
    if (started.length > 0 && onto === undefined) {
        const destinations = started.map((branch) => `${branch.repo} · ${branch.branch}`).join(", ");
        throw new Error(`This conversation lands to ${destinations}. Changes in ${repo} have no branch destination. Nothing was landed; move or undo those changes before landing to the branch.`);
    }
};
