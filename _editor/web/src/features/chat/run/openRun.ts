import { type WorkflowRun, WorkflowRunsListSchema } from "@intentic/sandbox-contract";
import { useAgents } from "../../agents/fleet/useAgents";
import { agentSeed } from "../../agents/fleet/useAgents-actions";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import type { RunSession } from "./chatRun";
import { summonChat } from "./summon";
import { useChat } from "./useChat";
import { agentTabOf, reveal } from "../panel/useChat-reveal";

// Opens a run into the chat from wherever it was pressed (board card, rail row, diagram column), through one module, so
// the three surfaces can't drift into different states for the same run.

// Puts a run's sessions into the panes, one column each; returns whether anything opened, so a caller can fall back to
// the diagram. A local reveal, never a summons: each window's panel follows its own ledger reads.
export const openRunSessions = (sessions: readonly RunSession[]): boolean => {
    if (sessions.length === 0) {
        return false;
    }
    const { active } = useChat();
    const { agentById, markSeen } = useAgents();
    const entries = sessions.map((session) => {
        const carded = agentById(session.conversationId);
        if (carded !== undefined) {
            markSeen(carded.id);
            return agentTabOf(agentSeed(carded));
        }
        // Off the fleet roster isn't the same as gone: the chat still opens and hydrates from the daemon by id alone.
        // The provider here is only a composer seed; getting it wrong doesn't affect the transcript.
        return agentTabOf({
            id: session.conversationId,
            provider: session.agent ?? active.value.provider.value,
            harness: session.harness ?? active.value.harness.value,
        });
    });
    reveal({ verb: `panes`, entries, focus: entries.at(-1)!.conversationId, caret: false });
    return true;
};

// Shows a run as `live` via summons, so every window's panel (including floating) follows from its own ledger reads,
// rather than opening a window: starting a workflow is starting agent work. `live` is a standing instruction
// re-evaluated every poll (runToFollow), not a one-shot reading. A bare id is checked against the ledger first, so a
// bad one shows nothing.
export const openRunInChat = async (run: WorkflowRun | string): Promise<void> => {
    if (typeof run !== `string`) {
        summonChat({ kind: `run`, runId: run.runId });
        return;
    }
    // The id named nothing in the ledger: nothing to show, nothing to claim.
    if ((await sandboxRuns()).some((entry) => entry.runId === run)) {
        summonChat({ kind: `run`, runId: run });
    }
};

const sandboxRuns = async (): Promise<WorkflowRun[]> => WorkflowRunsListSchema.parse(await sandboxJson(`/workflows/runs`)).runs;
