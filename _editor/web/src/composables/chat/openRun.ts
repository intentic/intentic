import { type WorkflowRun, WorkflowRunsListSchema } from "@intentic/sandbox-contract";
import { useAgents } from "../agents/useAgents";
import { sandboxJson } from "../sandbox/sandboxClient";
import { type RunSession, showRun } from "./chatRun";
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

/* Show a run: `live`, always, whatever state it is in.
 *
 * POPPED OUT FIRST, because that mode needs the room. The panes only exist in the window (a docked column is
 * ~22rem and a second pane in it would be two slivers), and the diagram takes the pane area — so a run opened
 * into a docked panel would set a split nobody can see and then draw nothing. Idempotent: a no-op when the
 * window is already up.
 *
 * IT NO LONGER DECIDES WHAT IS ON SCREEN, and that is the fix. It used to read the run's live sessions here and
 * fall back to the diagram when there were none — which was EVERY run started from a composer, because the
 * daemon acks with every step still `pending` and the scheduler has not run a line by the time this resolves.
 * So the press that started a workflow always landed on a picture, and nothing afterwards moved it: the panes
 * arrived only if the reader thought to click a node. `live` is a standing instruction instead of a one-shot
 * reading, and the panel honours it on every poll (chatRun's runToFollow) — the diagram while nothing is going,
 * the sessions the moment something is, and the next band when this one ends.
 *
 * TAKES AN ID AS WELL AS A RUN, because the extension that owns the Run button cannot hold a `WorkflowRun` on
 * this side of the host API (the contract imports extension-api, so extension-api cannot import the contract).
 * Given an id it reads the ledger once to check the run is real — a `chatRun` naming nothing would hang an
 * empty run bar over the panes — rather than waiting for the board's poll to come round.
 */
export const openRunInChat = async (run: WorkflowRun | string): Promise<void> => {
    useChatPopout().popOut();
    if (typeof run !== `string`) {
        showRun(run.runId, `live`);
        return;
    }
    // The id named nothing the ledger holds. Nothing to show and nothing to claim about it.
    if ((await sandboxRuns()).some((entry) => entry.runId === run)) {
        showRun(run, `live`);
    }
};

const sandboxRuns = async (): Promise<WorkflowRun[]> => WorkflowRunsListSchema.parse(await sandboxJson(`/workflows/runs`)).runs;
