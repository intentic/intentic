import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { IsolationPlan } from "../conversations/worktrees/isolation.js";
import { createAgentExecutionService, type AgentExecutionLease } from "../workload/agent-execution.js";
import { forgetNamespaceEntry, registerAgentDomainEntry } from "../workload/namespace-entry.js";

// Pure registry capabilities only: these PIDs and paths never name real processes/namespaces. The rollout override
// permits argv construction under a test policy, not a live launch or a production admission default.
export const domainExecution = async (pid: number): Promise<AgentExecutionLease & { readonly retire: () => void }> => {
    const service = createAgentExecutionService(
        async () => ({ agentDomain: "unprivileged" }),
        () => {},
    );
    const admission = await service.admit();
    const namespace = registerAgentDomainEntry(pid, { userNamespace: `/fake/${String(pid)}/ns/user`, home: "/home/agent" });
    const retire = (): void => forgetNamespaceEntry(namespace);
    const plan: IsolationPlan = {
        root: WORKSPACE_ROOT,
        worktree: `${HISTORY_ROOT}/test-runtime`,
        mirrors: [],
        overlays: `${HISTORY_ROOT}/test-overlays`,
        fence: undefined,
    };
    try {
        const lease = service.acquire(admission, {
            localCwd: plan.worktree,
            isolation: { plan, anchor: { pid, namespace, cwd: WORKSPACE_ROOT, plan, dispose: retire } },
        });
        return { ...lease, retire };
    } catch (error) {
        retire();
        throw error;
    } finally {
        service.close(admission);
    }
};
