import type { WorkflowRun } from "@intentic/sandbox-contract";
import { useAgents } from "../agents/useAgents";
import { liveSessions, type RunSession, showRun } from "./chatRun";
import { openAgentConversation, useChat } from "./useChat";
import { useChatPopout } from "./useChatPopout";

/* OPENING A RUN INTO THE CHAT, from wherever it was pressed — the fleet board's card, the rail's row, a column
 * of the diagram. One act, one module, because the three surfaces must not drift on it: a run opened from the
 * board and the same run opened from the rail landing in different states is the kind of difference nobody
 * reports as a bug, they just stop trusting one of the two doors.
 */

/* Put a set of the run's sessions into the panes, one column each. Returns whether anything opened, which is
 * what lets a caller fall back to the diagram rather than leaving the reader on an empty split.
 */
export const openRunSessions = (sessions: readonly RunSession[]): boolean => {
    if (sessions.length === 0) {
        return false;
    }
    const { active, openBeside, setPanes } = useChat();
    const { agentById, open: openAgent } = useAgents();
    for (const session of sessions) {
        // Claimed before opening, for the reason the board's card gestures do it: the opening would otherwise
        // take the focused pane's column on its way in.
        openBeside(session.conversationId);
        const carded = agentById(session.conversationId);
        if (carded !== undefined) {
            openAgent(carded);
            continue;
        }
        /* NOT ON THE FLEET, WHICH IS NOT THE SAME AS NOT EXISTING. A step that ran days ago has been swept off
         * the roster and still has its branch, its transcript and its record — so the chat opens from the id
         * alone and hydrates from the daemon. The provider is a SEED for the composer's opening pick (the
         * step's own pin, or failing that whatever this reader is already working in); nothing about the
         * transcript depends on getting it right, and a run whose sessions could not be reopened after a week
         * would make the diagram a picture of things you are no longer allowed to read. */
        openAgentConversation({
            id: session.conversationId,
            provider: session.agent ?? active.value.provider.value,
            harness: session.harness ?? active.value.harness.value,
        });
    }
    setPanes(sessions.map((session) => session.conversationId));
    return true;
};

/* Show a run: its live sessions if it has any, its diagram if it does not.
 *
 * POPPED OUT FIRST, because both of those need the room. The panes only exist in the window (a docked column
 * is ~22rem and a second pane in it would be two slivers), and the diagram takes the pane area — so a run
 * opened into a docked panel would set a split nobody can see and then draw nothing. Idempotent: a no-op when
 * the window is already up.
 *
 * A run with nothing live — finished, failed, or in the seconds between one step ending and the next
 * registering its conversation — opens on the DIAGRAM, which is the map you pick a session from. Same panel,
 * same run, other mode: the press always lands somewhere that can answer.
 */
export const openRunInChat = (run: WorkflowRun): void => {
    useChatPopout().popOut();
    showRun(run.runId, openRunSessions(liveSessions(run)) ? `sessions` : `graph`);
};
