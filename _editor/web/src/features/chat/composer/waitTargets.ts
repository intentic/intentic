import { effectiveAutoLand, turnInFlight, unregistered } from "../../agents/fleet/agentStatus";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";
import { parentOf } from "../../agents/board/ownership";

// Which agents a message can be booked to wait for (sendLater.ts's `after`), and how each one's work reaches the
// workspace. Pure over the fleet's cards, so the panel, the `@send:` list and their tests read one answer.

/** How an agent's work reaches the workspace: by itself, by the reader's land, or as it goes (the shared tree). */
export type LandsHow = `itself` | `you` | `workspace`;

/** An agent a message can be booked to wait for. */
export interface WaitTarget {
    readonly agent: FleetAgent;
    readonly lands: LandsHow;
}

// Anything of the agent's still to come: a turn under way or parked, work waiting on its branch or refused, a turn that
// ended short (its work lands once somebody carries it on or lands it), or words of its own waiting to go.
const pending = (agent: FleetAgent): boolean =>
    turnInFlight(agent) ||
    agent.status === `awaiting` ||
    agent.status === `ready` ||
    agent.status === `conflict` ||
    agent.status === `error` ||
    agent.status === `interrupted` ||
    agent.status === `stopped` ||
    (agent.queue?.items.length ?? 0) > 0;

// Work under way first, then work waiting on a press, then the rest, each newest first.
const rank = (agent: FleetAgent): number => {
    if (turnInFlight(agent) || agent.status === `awaiting`) {
        return 0;
    }
    return agent.status === `ready` || agent.status === `conflict` ? 1 : 2;
};

/**
 * The agents a message in conversation `self` can wait for: this sandbox's, live, not this one, not a spawned child
 * (whose work lands into its parent, which is the one to wait for), not one already waiting for this one (neither would
 * ever go), and with something of theirs still to land. One already finished with everything in has nothing to wait
 * for: Send is the press for that.
 */
export const waitTargets = (agents: readonly FleetAgent[], self: string, sandboxLands: boolean): readonly WaitTarget[] =>
    agents
        .filter(
            (agent) =>
                agent.id !== self &&
                agent.sandboxId === undefined &&
                agent.archivedAt === undefined &&
                !unregistered(agent.status) &&
                parentOf(agent.startedBy) === undefined &&
                agent.queue?.after !== self &&
                pending(agent),
        )
        .toSorted((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
        .map((agent) => ({ agent, lands: landsOf(agent, sandboxLands) }));

/** How one agent's work reaches the workspace, by the same fold its card's menu reads (effectiveAutoLand). */
export const landsOf = (agent: Pick<FleetAgent, "branch" | "autoLand">, sandboxLands: boolean): LandsHow => {
    if (agent.branch === undefined) {
        return `workspace`;
    }
    return effectiveAutoLand(agent, sandboxLands) ? `itself` : `you`;
};
