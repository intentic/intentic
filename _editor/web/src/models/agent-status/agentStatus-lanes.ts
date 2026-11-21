import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { laneOf } from "@intentic/sandbox-contract/models/agent-lanes";
import { type AgentStanding, awaitingUser, turnInFlight } from "@intentic/sandbox-contract/models/agent-standing";

// The lane projection every surface must agree with, and what of a fleet calls the reader, live in the contract
// (@intentic/sandbox-contract/models/agent-lanes.ts) since 2026-10-16: the daemon counts the desktop app's status bar by
// them (`agents.attention`). Re-exported here, where the editor has always imported them; the tile's rim stays.
export {
    callsOwner,
    runCallsOwner,
    NO_ATTENTION,
    laneOf,
    attentionCards,
    attentionCalls,
    fleetAttention,
} from "@intentic/sandbox-contract/models/agent-lanes";
export type { FleetLane, CallerStanding } from "@intentic/sandbox-contract/models/agent-lanes";

// Enough of an agent to draw its identity tile's rim; a FleetAgent, a roster AgentSummary and a test literal all fit.
export type RimAgent = AgentStanding & Pick<AgentSummary, "checklist">;

// What the identity tile's rim draws: a SegmentRing's props (`ring`, bound whole), in a Tailwind text-* tone (it draws
// in `currentColor`).
export interface TileRim {
    readonly ring: {
        readonly segments: number;
        readonly filled: number;
        readonly active: number;
        readonly asking: boolean;
        readonly seal: "open" | "active" | "closed";
    };
    readonly tone: string;
}

// THE RIM SAYS HOW FAR THE SESSION GOT, AND NOTHING ELSE. It used to fall back to the context window's fill for a
// session that kept no list, and a gauge reads as progress whatever it measures: most of Finished wore half-empty rims
// on work that was done. Context is the tile's hover now (AgentCard's tileHint), and the chat's own status bar, where
// it is acted on.
// ONE SEGMENT PER ITEM, SO THE RIM COUNTS WHAT THE LIST SAYS. The session's own ending was a segment too once, and five
// items drew six ticks; it is the seal now, a bead at 12 o'clock, which closes only once the card files in Finished
// (laneOf): a list emptied by a turn still running, a turn parked on a question, one that broke or was stopped is not a
// finished session. While the list is done and the session is not, the seal is what is in hand.
// WHAT IS IN HAND reads like the chat's own checklist: the items the agent marked in progress, part-lit. While the
// session waits on an answer they turn the info ink instead, so a glance tells "working on it" from "asked you"; asked
// with nothing marked, the next item is what waits.
// A session that kept no list is one item, the work itself: in hand while a turn works on it or asks, lit once it is
// finished, so Finished's many short sessions still read as closed rather than as nothing done.
export const tileRim = (agent: RimAgent, { quiet }: { quiet: boolean }): TileRim => {
    // A quiet rim states its count without arguing for it, which is what a receipt and a destination row both want.
    const tone = quiet ? `text-subtle` : `text-accent`;
    const total = agent.checklist?.total ?? 0;
    // The daemon promises done <= total; a frame that broke it would otherwise light more segments than exist.
    const done = Math.min(agent.checklist?.done ?? 0, total);
    if (laneOf(agent) === `finished`) {
        return { ring: { segments: Math.max(1, total), filled: total === 0 ? 1 : done, active: 0, asking: false, seal: `closed` }, tone };
    }
    const asking = awaitingUser(agent);
    // Only a turn at work or one waiting on an answer holds anything. A draft, a card that broke or was stopped, and one
    // that waits for its time have nothing in hand, and their corner says why: a part-lit rim on them read as at work.
    const holding = asking || turnInFlight(agent);
    if (total === 0) {
        return { ring: { segments: 1, filled: 0, active: holding ? 1 : 0, asking, seal: `open` }, tone };
    }
    if (done === total) {
        return { ring: { segments: total, filled: done, active: 0, asking, seal: holding ? `active` : `open` }, tone };
    }
    const doing = holding ? Math.min(agent.checklist?.doing ?? 0, total - done) : 0;
    return { ring: { segments: total, filled: done, active: doing > 0 ? doing : asking ? 1 : 0, asking, seal: `open` }, tone };
};
