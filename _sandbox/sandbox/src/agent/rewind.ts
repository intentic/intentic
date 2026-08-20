import type { RewindResult } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../composition.js";
import type { TurnAnchor } from "./turn-anchors.js";

/* REWIND, "go back to that message and try again", as one operation.
 *
 * Three things have to move together or the conversation is left describing a workspace that no longer
 * matches it: the FILES go back to the state that turn found, the MESSAGES after it are dropped, and the
 * PROVIDER SESSION is forgotten. Restoring files alone is the tempting half-measure and it is incoherent,
 * the agent's context would still hold the edits, so its next turn reasons from work that is no longer on
 * disk, and the surest way to see it is to ask it to "continue" and watch it re-apply a diff that vanished.
 *
 * WHERE the files go back to depends on where the conversation works, and that is the whole of what the two
 * arms below are: a main-tree conversation returns to a workspace checkpoint, an isolated one to the commits
 * its own branch stood on at the top of that turn. The ANCHOR says which, nothing here asks the registry
 * whether the conversation "is isolated", because a conversation that has since changed placement would answer
 * for today rather than for the turn being rewound to.
 *
 * WHY THE LEASE WRAPS ALL OF IT rather than a running-turn check up front: a turn admitted between the check
 * and the first `git checkout` lands mid-restore, and there is no recovering that, half the files are the
 * agent's, half are the anchor's, and neither the turn nor the restore is what the user asked for.
 * agents-registry's withRewindLease is the same mutex a turn takes, so the two cannot interleave at all.
 * (Synara reaches the same conclusion in its TurnCheckpointCoordinator, for the same reason.)
 *
 * ORDER MATTERS INSIDE THE LEASE, and it is: files, then transcript, then session. Files before transcript
 * because a failed restore must leave the conversation intact: a transcript truncated against a workspace that
 * never moved is the one state with no way back. On the main tree the pre-restore snapshot is taken by
 * history.restore itself before it touches anything, so that rewind is undoable by the timeline it came from,
 * the one thing that makes a destructive button safe to press. An isolated rewind has the same property by a
 * different road: what it discards is uncommitted worktree state, and everything the agent has COMMITTED stays
 * reachable on its own branch. */

export type RewindDeps = Pick<Services, "agents" | "agentWorktrees" | "history" | "transcripts" | "turnAnchors" | "logger">;

// What a rewind can refuse for, as values rather than throws, the route maps each to its own status, and both
// are ordinary outcomes rather than failures.
export type RewindRefusal = "busy" | "no-checkpoint";

/* Put an isolated conversation's checkout back to the commits it stood on. `reset --hard` moves the branch and
 * the working tree together, and the clean sweeps what the turn created since; ignored files (node_modules, a
 * .env the agent was handed) survive both, exactly as they do in a main-tree restore.
 *
 * A repo in the anchor whose checkout has since gone is skipped rather than fatal: the conversation may have
 * been archived and re-attached with a different composition, and the repos it still HAS are worth putting
 * back. None of them landing is the failure, that is a checkout that is not there any more. */
const resetWorktree = async (
    services: RewindDeps,
    conversationId: string,
    anchor: Extract<TurnAnchor, { kind: "worktree" }>,
    git: GitRunner,
): Promise<boolean> => {
    let restored = false;
    for (const { repo, base } of anchor.repos) {
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
    const outcome = await services.agents.withRewindLease(conversationId, async (): Promise<RewindResult | RewindRefusal> => {
        /* Resolved INSIDE the lease. The anchors are not frozen, a turn starting records one, so a lookup
         * done before the lease could name a state that a concurrent turn has since made the wrong answer.
         * Under the lease no turn can be running, so what this resolves is what gets restored. */
        const anchor = await services.turnAnchors.of(conversationId, index);
        if (anchor === undefined) {
            return "no-checkpoint";
        }
        if (anchor.kind === "tree") {
            if (!(await services.history.restore(anchor.snapshot))) {
                // The id came from the anchor store moments ago, so this is a checkpoint that vanished
                // underneath us rather than a bad request, worth a line, and still "nothing to go back to"
                // from the user's side.
                services.logger.warn({ conversationId, snapshot: anchor.snapshot }, "rewind: checkpoint disappeared between lookup and restore");
                return "no-checkpoint";
            }
        } else if (!(await resetWorktree(services, conversationId, anchor, git))) {
            return "no-checkpoint";
        }
        const agent = services.agents.entry(conversationId);
        const dropped =
            agent === undefined
                ? 0
                : await services.transcripts.truncate({ id: conversationId, provider: agent.provider, harness: agent.harness }, index);
        // The dropped turns' own anchors go with them: a state offered for a message that is no longer in the
        // transcript is a button that restores to something nothing on screen explains.
        await services.turnAnchors.truncate(conversationId, index + 1);
        await services.agents.clearSession(conversationId);
        // The timeline has a point to select only where the rewind moved through it; an isolated rewind moved
        // the conversation's own branch, which that timeline does not carry.
        return { dropped, ...(anchor.kind === "tree" ? { snapshot: anchor.snapshot } : {}) };
    });
    // withRewindLease answers undefined for exactly one reason: a turn holds the conversation.
    return outcome ?? "busy";
};
