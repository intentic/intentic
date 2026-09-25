import type { RepoBase } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { headSha } from "../../git/changes/changes.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import type { AgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import type { TurnCheckpoint } from "./turn-checkpoints.js";

// Pins an isolated conversation's checkout (an isolated turn has no workspace-history capture to checkpoint on): commits
// what the checkout holds, then reads back the commit per repo, since HEAD alone would miss prior turns' uncommitted
// work. A failing repo drops out without failing the others; an checkpoint covering some repos beats none.

export interface CheckpointDeps {
    readonly agentWorktrees: Pick<AgentWorktrees, "worktreeDir" | "mainDir">;
    readonly logger: Logger;
}

// Resolves `forkOf.files: 'then'` to the source's own commits, or undefined when it can't; the caller then falls back
// to today's files rather than refuse the fork. Shas come from the daemon's own record only, never the request.
export const forkWorktreeBase = async (
    checkpoints: { readonly of: (conversationId: string, index: number) => Promise<TurnCheckpoint | undefined> },
    forkOf: { readonly conversationId: string; readonly keep: number; readonly files: "then" | "now" } | undefined,
): Promise<RepoBase[] | undefined> => {
    if (forkOf?.files !== "then") {
        return undefined;
    }
    const checkpoint = await checkpoints.of(forkOf.conversationId, forkOf.keep);
    return checkpoint?.kind === "worktree" ? [...checkpoint.repos] : undefined;
};

export const checkpointWorktree = async (
    services: CheckpointDeps,
    conversationId: string,
    repos: readonly { readonly repo: string; readonly base: string }[],
    // Commit message shown in `git log`; a steered message needs its own title, distinct from the turn boundary's.
    title = "Agent: before this turn",
    git: GitRunner = defaultGit,
): Promise<RepoBase[]> => {
    const anchored: RepoBase[] = [];
    for (const { repo } of repos) {
        const dir = services.agentWorktrees.worktreeDir(conversationId, repo);
        try {
            // Porcelain flags staged, unstaged and untracked changes but over-reports; the index decides what actually
            // goes in.
            const { stdout } = await git(dir, ["status", "--porcelain", "-z"]);
            if (stdout !== "") {
                // Titled as the turn boundary, so `git log` shows where each turn began instead of identical commit
                // names.
                await commitWorktreeRemainder(repo, dir, title, services.agentWorktrees.mainDir("root"), git);
            }
            const base = await headSha(dir, git);
            if (base !== undefined) {
                anchored.push({ repo, base });
            }
        } catch (error) {
            services.logger.warn({ err: error, conversationId, repo }, "checkpoints: pinning the worktree failed");
        }
    }
    return anchored;
};
