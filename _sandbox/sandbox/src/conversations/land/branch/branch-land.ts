import type { LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { commitIndex } from "../../../git/changes/changes-index.js";
import { AGENT_GIT_AUTHOR, withConversationTrailer } from "../../../git-identity.js";
import type { IsolatedAgent, WorktreePlacement } from "../../registry/agents-store.js";
import type { BranchCheckouts } from "../../worktrees/branches/branch-checkouts.js";

// A LAND ONTO A BRANCH (2026-10-29). A repo a conversation was started from a branch of (branch-repos.ts) lands the way
// every repo does (land.ts), with the branch's checkout (worktrees/branches/branch-checkouts.ts) standing where the main tree
// would: the delta is measured against it, judged against it and written into it, and the write proven there. Then,
// unlike the main tree, where a land waits uncommitted for the owner, it is committed, so the branch itself moves and
// the checkout is clean again for the next reader. A merge that left conflict markers is undone and reported as the
// conflict it is instead: nobody edits that checkout, so nobody would ever resolve them there. The shared tree is never
// read or written for such a repo, nor its derived files re-derived (rederive.ts).

/** Where one repo's work goes instead of the main tree: the branch, and the checkout of it a land writes into. */
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
 * Each of the conversation's repos started from a branch, its checkout brought to the branch's tip with nothing in it;
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

/** What a write onto a branch is committed as: `Agent: <title>`, trailed with the conversation like its own commits. */
export interface BranchOnto {
    readonly branch: string;
    readonly message: string;
}

export const branchOnto = (line: BranchLine | undefined, entry: Pick<IsolatedAgent, "id" | "social">): BranchOnto | undefined =>
    line === undefined ? undefined : { branch: line.branch, message: withConversationTrailer(`Agent: ${entry.social.title?.text ?? entry.id}`, entry.id) };

// Back to the branch's tip with nothing else in it, the state every reader of the checkout expects.
const putBack = async (dir: string, git: GitRunner): Promise<void> => {
    await git(dir, ["reset", "-q", "--hard", "HEAD"]);
    await git(dir, ["clean", "-q", "-fd"]);
};

/**
 * After a write into a branch's checkout is proven there: committed onto the branch, so it moves. A merge that left
 * markers (`conflicted`) is put back instead and answered as its conflict, the branch named where the main line's
 * would be. Undefined once committed, or when the write left nothing to commit.
 */
export const settleOnBranch = async (
    dir: string,
    repo: string,
    conflicted: readonly string[],
    onto: BranchOnto,
    git: GitRunner = defaultGit,
): Promise<LandConflict | undefined> => {
    if (conflicted.length > 0) {
        await putBack(dir, git);
        return { repo, paths: conflicted.map((path) => ({ path, reason: "diverged" as const })), clean: 0, mainBranch: onto.branch };
    }
    try {
        await git(dir, ["add", "-A"]);
        // Hooks skipped, as every commit the daemon makes for an agent: the work was the agent's, and so is its checking.
        await commitIndex(dir, onto.message, AGENT_GIT_AUTHOR, git, "skip");
        return undefined;
    } catch (error) {
        // A commit that did not go through leaves the checkout as it was before the write, and the land throws.
        // allow(silent-catch): the commit's own error is what the land reports; a put-back that fails too is mended by
        // the next refresh, which resets this daemon-owned checkout to its branch before anything reads it.
        await putBack(dir, git).catch(() => undefined);
        throw error;
    }
};
