import type { AgentSummary } from "@intentic/sandbox-contract";
import { cardProjection } from "../agents/registry/card-projection.js";

/* WHAT THE FLEET CARD SAYS ABOUT A LOOP, the live half of a loop, kept here and nowhere else. */

export type LoopProjection = NonNullable<AgentSummary["loop"]>;

export const loopProjection = cardProjection<LoopProjection>();
