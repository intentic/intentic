import type { AgentSummary } from "@intentic/sandbox-contract";
import { cardProjection } from "../agents/card-projection.js";

/* WHAT THE FLEET CARD SAYS ABOUT A LOOP, the live half of a loop, kept here and nowhere else.
 *
 * The mechanism (an import-light map the registry reads by call, with a change notification) is
 * card-projection.ts; this is only the loop's use of it. The pump publishes at each iteration boundary and once
 * more when the loop ends, and that last one is why the notification exists: no turn frame follows it to
 * broadcast the roster.
 */

export type LoopProjection = NonNullable<AgentSummary["loop"]>;

export const loopProjection = cardProjection<LoopProjection>();
