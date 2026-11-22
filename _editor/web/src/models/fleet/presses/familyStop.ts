import type { AgentFamilyStopped, AgentScriptRun } from "@intentic/sandbox-contract/schemas/agents";
import { t } from "@intentic/ui/i18n";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { startOperation } from "../../../workbench/operations/operations";
import { agentWork } from "../agentActions";
import type { FleetAgent } from "../useAgents-fleet";

// STOP EVERYTHING, AND A WORKFLOW'S OWN STOP (agents.stopFamily). A conversation's Stop ends only its turn, and a child's
// only that child, while a workflow run its agent started goes on starting the next agent as each one stops, with its
// conversation at rest (2026-11-22: an owner stopped a run's agents one by one on marta while it started more, until the
// agent was told in words to stop it). So a card names its runs in its tray, each with a Stop (ScriptRunRow), and its
// menu offers Stop everything while anything below it is at work or will start.

/** Whether anything below this card is at work or will start by itself: a workflow run going, or a subagent working. */
export const familyGoing = (agent: Pick<FleetAgent, `scriptRuns` | `subagents`>): boolean =>
    (agent.scriptRuns?.length ?? 0) > 0 || (agent.subagents?.running ?? 0) > 0;

// What the receipt says was stopped: the agents and the runs, each counted, or that nothing was still going.
const stoppedWords = ({ agents, runs }: AgentFamilyStopped): string => {
    const parts = [
        ...(agents > 0 ? [t(`agents.familyStop.agents`, { count: agents }, agents)] : []),
        ...(runs > 0 ? [t(`agents.familyStop.runs`, { count: runs }, runs)] : []),
    ];
    return parts.length === 0 ? t(`agents.familyStop.nothing`) : t(`agents.familyStop.stopped`, { what: parts.join(`, `) });
};

/**
 * Stops everything a card has going and everything below it, or, naming one of its runs, that run and its agents. The
 * press goes through the ledger, so its receipt says what stopped; the card loses the run as the daemon ends it.
 */
export const pressStopFamily = (agent: Pick<FleetAgent, `id` | `title`>, run?: AgentScriptRun): void => {
    void startOperation(`${agentWork(agent.id)}/stop-family${run === undefined ? `` : `/${run.id}`}`, {
        what: run === undefined ? t(`agents.familyStop.stopping`, { title: agent.title ?? agent.id }) : t(`agents.familyStop.stoppingRun`, { name: run.name }),
        done: stoppedWords,
        failed: t(`agents.familyStop.failed`),
        task: () => sandboxRpc.agents.stopFamily({ id: agent.id, run: run?.id }),
    });
};
