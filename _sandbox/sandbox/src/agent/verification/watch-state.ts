import type { AgentWatch } from "@intentic/sandbox-contract";
import { cardProjection } from "../../agents/registry/card-projection.js";

// What the fleet card says about a conversation's armed watches: a leaf like card-projection.ts, since watchers.ts
// imports the steering registry and would close a cycle. A watch transitions between turns, armed at the end of one and
// fired hours later, so the change notification matters more here than elsewhere. An empty array is published as the
// cleared state: a fired watch has nothing left to report, and the registry drops it from the wire so absence is the
// signal.

export const watchProjection = cardProjection<readonly AgentWatch[]>();
