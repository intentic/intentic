import type { RewindResult } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

/* REWIND — "go back to that message and try again", as one operation.
 *
 * Three things have to move together or the conversation is left describing a workspace that no longer
 * matches it: the FILES go back to the checkpoint that turn produced, the MESSAGES after it are dropped, and
 * the PROVIDER SESSION is forgotten. Restoring files alone is the tempting half-measure and it is incoherent —
 * the agent's context would still hold the edits, so its next turn reasons from work that is no longer on
 * disk, and the surest way to see it is to ask it to "continue" and watch it re-apply a diff that vanished.
 *
 * WHY THE LEASE WRAPS ALL OF IT rather than a running-turn check up front: a turn admitted between the check
 * and the first `git checkout` lands mid-restore, and there is no recovering that — half the files are the
 * agent's, half are the checkpoint's, and neither the turn nor the restore is what the user asked for.
 * agents-registry's withRewindLease is the same mutex a turn takes, so the two cannot interleave at all.
 * (Synara reaches the same conclusion in its TurnCheckpointCoordinator, for the same reason.)
 *
 * ORDER MATTERS INSIDE THE LEASE, and it is: checkpoint first, then files, then transcript, then session.
 * The pre-restore snapshot is taken by history.restore itself before it touches anything, so a rewind is
 * undoable by the same timeline it came from — the one thing that makes a destructive button safe to press.
 * Files before transcript because a failed restore must leave the conversation intact: a transcript truncated
 * against a workspace that never moved is the one state with no way back. */

export type RewindDeps = Pick<Services, "agents" | "history" | "transcripts" | "rewindPoints" | "logger">;

// What a rewind can refuse for, as values rather than throws — the route maps each to its own status, and both
// are ordinary outcomes rather than failures.
export type RewindRefusal = "busy" | "no-checkpoint";

export const rewindConversation = async (
    services: RewindDeps,
    conversationId: string,
    index: number,
): Promise<RewindResult | RewindRefusal> => {
    const outcome = await services.agents.withRewindLease(conversationId, async (): Promise<RewindResult | RewindRefusal> => {
        /* Resolved INSIDE the lease. The rewind points are not frozen — a turn starting records one — so a
         * lookup done before the lease could name a checkpoint that a concurrent turn has since made the wrong
         * answer. Under the lease no turn can be running, so what this resolves is what gets restored. */
        const snapshot = await services.rewindPoints.of(conversationId, index);
        if (snapshot === undefined) {
            return "no-checkpoint";
        }
        if (!(await services.history.restore(snapshot))) {
            // The id came from snapshotFor moments ago, so this is a checkpoint that vanished underneath us
            // rather than a bad request — worth a line, and still "nothing to go back to" from the user's side.
            services.logger.warn({ conversationId, snapshot }, "rewind: checkpoint disappeared between lookup and restore");
            return "no-checkpoint";
        }
        const agent = services.agents.entry(conversationId);
        const dropped =
            agent === undefined
                ? 0
                : await services.transcripts.truncate({ id: conversationId, provider: agent.provider, harness: agent.harness }, index);
        // The dropped turns' own rewind points go with them: a checkpoint offered for a message that is no
        // longer in the transcript is a button that restores to a state nothing on screen explains.
        await services.rewindPoints.truncate(conversationId, index + 1);
        await services.agents.clearSession(conversationId);
        return { snapshot, dropped };
    });
    // withRewindLease answers undefined for exactly one reason: a turn holds the conversation.
    return outcome ?? "busy";
};
