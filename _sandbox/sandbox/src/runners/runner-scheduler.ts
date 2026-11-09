import { WORKLOAD_COST_BYTES } from "../workload/resource-budget.js";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";

// How many agents a machine holds at once, and whether an agent's sign-in can reach a runner at all: the two facts every
// placement starts from. Which machine a child or a heavy command goes to is decided by one rule over one reading
// (fleet-advice.ts), the same one a new session's suggestion reads.

// Two ceilings, whichever is lower: cores minus 2 (capped at 16, the local fan-out rule) and memory over what one agent
// costs, the same figure an admission here holds (workload/resource-budget.ts).
const MEMORY_PER_AGENT_MB = WORKLOAD_COST_BYTES.agentRuntime / 1024 ** 2;
export const runnerSlots = (facts: RunnerFacts): number =>
    Math.max(1, Math.min(16, facts.cpus - 2, Math.floor(facts.memoryMb / MEMORY_PER_AGENT_MB)));

// Whether an agent's credential can reach the runner. Only the Claude Code runtime family travels; every other runtime
// needs its own login already on that machine, which a fresh runner lacks.
export const credentialsTravel = (provider: AgentProvider, harness: AgentHarness): boolean => capabilitiesOf(provider, harness).runtime === "claude-code";
