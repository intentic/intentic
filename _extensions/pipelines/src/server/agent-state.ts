import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// Whether a conversation has a turn live (running, parked on its person, unwinding a stop, or coming back from a repair),
// read off its card as the daemon serves it: what the fixer asked the daemon's actors while it was the daemon's.
export const IN_FLIGHT: ReadonlySet<AgentSummary["status"]> = new Set(["running", "awaiting", "resuming", "stopping", "dismissing"]);

export const runningOf = (agent: Pick<AgentSummary, "status">): boolean => IN_FLIGHT.has(agent.status);
