import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// What the roster says about how far past its first run a sandbox is, for what is offered only once that is over: the
// getting-started checklist stops offering itself there, and the community invitation (features/community) starts.

// How long a sandbox counts as new: an agent quiet for longer than this was not started on its first run.
const FIRST_DAYS_MS = 7 * 24 * 60 * 60_000;

/** Agent work has reached the workspace: the whole loop has been gone round at least once. */
export const workLanded = (agents: readonly AgentSummary[]): boolean =>
    agents.some((agent) => agent.status === `landed` || (agent.landedPresence?.landed ?? 0) > 0);

/** The sandbox has agents older than its first days: a long-standing user, whether or not they land through review. */
export const pastFirstDays = (agents: readonly AgentSummary[], now: number): boolean => agents.some((agent) => now - agent.updatedAt > FIRST_DAYS_MS);
