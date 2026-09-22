import type { AgentJob } from "@intentic/sandbox-contract";
import { cardProjection } from "../../agents/registry/card-projection.js";

// A leaf like watch-state.ts, so the agents registry reads a conversation's jobs without importing the job registry.

export const jobProjection = cardProjection<readonly AgentJob[]>();
