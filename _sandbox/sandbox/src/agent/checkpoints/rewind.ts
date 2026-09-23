import type { RewindResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import type { TurnCheckpoint } from "./turn-checkpoints.js";

// Rewind moves three things together: files, messages after the turn, and the provider session; restoring only files
// would leave the agent's context referencing edits no longer on disk. Which arm restores comes from the checkpoint
// recorded at that turn, not a live placement check. The lease wraps all three steps so a turn can't be admitted
// mid-restore; order is files, then transcript, then session, since a failed restore must leave the conversation
// intact.

export type RewindDeps = Pick<Services, "agents" | "conversations" | "agentWorktrees" | "history" | "transcripts" | "turnCheckpoints" | "logger">;

// Refusal reasons as values, not throws; the route maps each to its own status, both ordinary outcomes.
export type RewindRefusal = "busy" | "no-checkpoint";

// Resets an isolated checkout to its anchored commits (`reset --hard` + clean); ignored files (node_modules) survive,
// as in a main-tree restore. A missing repo is skipped, not fatal; only none landing is a failure.
const resetWorktree = async (
    services: RewindDeps,
    conversationId: string,
    checkpoint: Extract<TurnCheckpoint, { kind: "worktree" }>,
    git: GitRunner,
): Promise<boolean> => {
    let restored = false;
    for (const { repo, base } of checkpoint.repos) {
        const dir = services.agentWorktrees.worktreeDir(conversationId, repo);
        try {
            await git(dir, ["reset", "--hard", base]);
            await git(dir, ["clean", "-q", "-f", "-d"]);
            restored = true;
        } catch (error) {
            services.logger.warn({ err: error, conversationId, repo }, "rewind: worktree reset failed");
        }
    }
    return restored;
};

export const rewindConversation = async (
    services: RewindDeps,
    conversationId: string,
    index: number,
    git: GitRunner = defaultGit,
): Promise<RewindResult | RewindRefusal> => {
    const outcome = await services.conversations.withRewindLease(conversationId, async (): Promise<RewindResult | RewindRefusal> => {
        // Resolved inside the lease, since checkpoints aren't frozen; a lookup before the lease could get a stale answer.
        const checkpoint = await services.turnCheckpoints.of(conversationId, index);
        if (checkpoint === undefined) {
            return "no-checkpoint";
        }
        if (checkpoint.kind === "tree") {
            if (!(await services.history.restore(checkpoint.snapshot))) {
                // The id came from the checkpoint store moments ago: this checkpoint vanished underneath us, not a bad
                // request.
                services.logger.warn({ conversationId, snapshot: checkpoint.snapshot }, "rewind: checkpoint disappeared between lookup and restore");
                return "no-checkpoint";
            }
        } else if (!(await resetWorktree(services, conversationId, checkpoint, git))) {
            return "no-checkpoint";
        }
        const dropped = services.agents.entry(conversationId) === undefined ? 0 : await services.transcripts.truncate({ id: conversationId }, index);
        // Dropped turns' checkpoints go with them, so no state is offered for a message no longer in the transcript.
        await services.turnCheckpoints.truncate(conversationId, index + 1);
        await services.conversations.send(conversationId, { kind: "session-cleared" }).settled;
        // Timeline has a point only where the rewind moved through it; an isolated rewind moves the branch instead.
        return { dropped, ...(checkpoint.kind === "tree" ? { snapshot: checkpoint.snapshot } : {}) };
    });
    // withRewindLease answers undefined for exactly one reason: a turn holds the conversation.
    return outcome ?? "busy";
};
