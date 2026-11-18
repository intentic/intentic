import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { inProject } from "../../../app/projectScope";

// Which conversations a project-scoped board shows: the ones with evidence of belonging. A conversation belongs to a
// project when it opened inside it, or when the role it acts as starts inside it or carries a repository in or around
// it. (Which folders a role may touch is access, an access profile's areas, and says nothing of where it works.) A
// role that says nothing about the project, and a root-started conversation with no role,
// belong to "All projects" only: the scope narrows the board, it does not relabel it. Held wakes and workflow runs
// follow the same evidence: a wake's thread or role, a run's steps. Pure over the summaries and the role cards.

type Member = Pick<AgentSummary, "id" | "startIn" | "actsAs" | "workflow">;

const touches = (folder: string, project: string): boolean => inProject(folder, project) || inProject(project, folder);

// Whether a role card reaches the project: starts in it, or carries a repository inside or around it.
export const roleInProject = (role: Role, project: string): boolean => {
    const startIn = role.workspace?.startIn;
    if (startIn !== undefined && startIn !== `` && inProject(startIn, project)) {
        return true;
    }
    return (role.context?.repos ?? []).some((repo) => touches(repo, project));
};

export const agentInProject = (
    agent: Pick<AgentSummary, "startIn" | "actsAs">,
    project: string,
    roles: readonly Role[],
): boolean => {
    if (agent.startIn !== undefined && agent.startIn !== `` && inProject(agent.startIn, project)) {
        return true;
    }
    const role = agent.actsAs === undefined ? undefined : roles.find((card) => card.id === agent.actsAs);
    return role !== undefined && roleInProject(role, project);
};

// A held wake belongs where the thread it continues does, or where the role it would speak as reaches. One with
// neither is a sandbox-wide hold and stays under All projects.
export const heldWakeInProject = (
    wake: Pick<AutomationApproval, "conversationId" | "actsAs">,
    project: string,
    roles: readonly Role[],
    fleet: readonly Member[],
): boolean => {
    const thread = wake.conversationId === undefined ? undefined : fleet.find((agent) => agent.id === wake.conversationId);
    if (thread !== undefined && agentInProject(thread, project, roles)) {
        return true;
    }
    return agentInProject({ actsAs: wake.actsAs }, project, roles);
};

// A run belongs where any of its steps does. One whose steps have not opened yet carries no evidence and stays under
// All projects.
export const runInProject = (run: Pick<WorkflowRun, "runId">, project: string, roles: readonly Role[], fleet: readonly Member[]): boolean =>
    fleet.some((agent) => agent.workflow?.runId === run.runId && agentInProject(agent, project, roles));
