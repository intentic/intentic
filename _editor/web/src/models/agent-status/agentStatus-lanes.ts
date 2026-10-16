import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { laneOf } from "@intentic/sandbox-contract/models/agent-lanes";
import type { AgentStanding } from "@intentic/sandbox-contract/models/agent-standing";

// The lane projection every surface must agree with, and what of a fleet calls the reader, live in the contract
// (@intentic/sandbox-contract/models/agent-lanes.ts) since 2026-10-16: the daemon counts the desktop app's status bar by
// them (`agents.attention`). Re-exported here, where the editor has always imported them; the tile's rim stays.
export {
    callsOwner,
    NO_ATTENTION,
    laneOf,
    attentionCards,
    attentionCalls,
    fleetAttention,
} from "@intentic/sandbox-contract/models/agent-lanes";
export type { FleetLane, CallerStanding } from "@intentic/sandbox-contract/models/agent-lanes";

// Enough of an agent to draw its identity tile's rim; a FleetAgent, a roster AgentSummary and a test literal all fit.
export type RimAgent = AgentStanding & Pick<AgentSummary, "checklist">;

// What the identity tile's rim draws: lit segments of a SegmentRing, in a Tailwind text-* tone (it draws in
// `currentColor`).
export interface TileRim {
    readonly segments: number;
    readonly filled: number;
    readonly tone: string;
}

// THE RIM SAYS HOW FAR THE SESSION GOT, AND NOTHING ELSE. It used to fall back to the context window's fill for a
// session that kept no list, and a gauge reads as progress whatever it measures: most of Finished wore half-empty rims
// on work that was done. Context is the tile's hover now (AgentCard's tileHint), and the chat's own status bar, where
// it is acted on.
// SEGMENTS ARE ITEMS PLUS ONE, the extra being the session's own ending, and it closes only once the card files in
// Finished (laneOf): a list emptied by a turn still running, a turn parked on a question, one that broke or was stopped
// is not a finished session, and a closed ring would claim it was. A session that kept no list is the same rule with no
// items: one segment, empty until it is done and whole after, so a closed ring is a finished card's default and a gap
// in Finished means a list left short.
export const tileRim = (agent: RimAgent, { quiet }: { quiet: boolean }): TileRim => {
    const total = agent.checklist?.total ?? 0;
    // The daemon promises done <= total; a frame that broke it would otherwise light more segments than exist.
    const done = Math.min(agent.checklist?.done ?? 0, total);
    const finished = done === total && laneOf(agent) === `finished`;
    // A quiet rim states its count without arguing for it, which is what a receipt and a destination row both want.
    return { segments: total + 1, filled: finished ? total + 1 : done, tone: quiet ? `text-subtle` : `text-accent` };
};
