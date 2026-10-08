import type { AgentDomainPolicy } from "@intentic/sandbox-contract";
import { createAgentExecutionService, type AgentExecutionLease, type AgentExecutionPlacement, type AgentExecutionService } from "./agent-execution.js";

// Test-only protected-reader seam: root is an explicit policy answer, never a production admission default.
// Keep the real rollout gate, registry and leases; no namespace or process is created here.
export const rootExecutionService = (): AgentExecutionService => {
    const readProtectedPolicy = async (): Promise<AgentDomainPolicy> => ({ agentDomain: "root" });
    return createAgentExecutionService(readProtectedPolicy);
};

const service = rootExecutionService();
const admission = await service.admit();

// Issued fixtures bind the same placement identity the request carries. Rebind when cwd or isolation changes.
export const rootExecution = (placement: AgentExecutionPlacement): AgentExecutionLease => service.acquire(admission, placement);
