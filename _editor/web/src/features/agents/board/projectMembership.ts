import type { AgentSummary, AutomationApproval, Persona, WorkflowRun } from "@intentic/sandbox-contract";
import { inProject } from "../../../app/projectScope";

// Which conversations a project-scoped board shows: the ones with evidence of belonging. A conversation belongs to a
// project when it opened inside it, or when the persona it acts as starts inside it or names it (a carried repository,
// a fenced folder). A persona that says nothing about the project, and a root-started conversation with no persona,
// belong to "All projects" only: the scope narrows the board, it does not relabel it. Held wakes and workflow runs
// follow the same evidence: a wake's thread or persona, a run's steps. Pure over the summaries and the persona cards.

type Member = Pick<AgentSummary, "id" | "startIn" | "actsAs" | "workflow">;

const touches = (folder: string, project: string): boolean => inProject(folder, project) || inProject(project, folder);

// Whether a persona card reaches the project: starts in it, carries it, or is fenced to a folder inside or around it.
export const personaInProject = (persona: Persona, project: string): boolean => {
    const startIn = persona.workspace?.startIn;
    if (startIn !== undefined && startIn !== `` && inProject(startIn, project)) {
        return true;
    }
    if ((persona.context?.repos ?? []).some((repo) => touches(repo, project))) {
        return true;
    }
    return (persona.workspace?.folders ?? []).some((folder) => touches(folder, project));
};

export const agentInProject = (
    agent: Pick<AgentSummary, "startIn" | "actsAs">,
    project: string,
    personas: readonly Persona[],
): boolean => {
    if (agent.startIn !== undefined && agent.startIn !== `` && inProject(agent.startIn, project)) {
        return true;
    }
    const persona = agent.actsAs === undefined ? undefined : personas.find((card) => card.id === agent.actsAs);
    return persona !== undefined && personaInProject(persona, project);
};

// A held wake belongs where the thread it continues does, or where the persona it would speak as reaches. One with
// neither is a sandbox-wide hold and stays under All projects.
export const heldWakeInProject = (
    wake: Pick<AutomationApproval, "conversationId" | "actsAs">,
    project: string,
    personas: readonly Persona[],
    fleet: readonly Member[],
): boolean => {
    const thread = wake.conversationId === undefined ? undefined : fleet.find((agent) => agent.id === wake.conversationId);
    if (thread !== undefined && agentInProject(thread, project, personas)) {
        return true;
    }
    return agentInProject({ actsAs: wake.actsAs }, project, personas);
};

// A run belongs where any of its steps does. One whose steps have not opened yet carries no evidence and stays under
// All projects.
export const runInProject = (run: Pick<WorkflowRun, "runId">, project: string, personas: readonly Persona[], fleet: readonly Member[]): boolean =>
    fleet.some((agent) => agent.workflow?.runId === run.runId && agentInProject(agent, project, personas));
