import { laneOf, type FleetAgent, type FleetLane } from "./useAgents";

/* What dragging a card across the board actually DOES. The lanes are pure projections of the daemon's status
 * machine (laneOf), so a drop cannot assign a status — it can only invoke the action that CAUSES one, and only
 * some drops have an action behind them. Everything else is refused: the lane never lights up and the card
 * springs back. That is the honest answer, not a missing feature — there is no way to make an agent "be
 * running" without sending it a message, and no way to manufacture a pending question on its behalf.
 *
 * Both functions below walk the same guards in the same order, so the refusal always explains the refusal that
 * actually happened. */

// `discard` is not a lane — it's the drop zone the board reveals while a card is in flight.
export type DropTarget = FleetLane | "discard";
export type DropAction = "land" | "stop" | "discard";

export const dropActionFor = (agent: FleetAgent, target: DropTarget): DropAction | undefined => {
    // A draft is an open tab that never ran: no registry entry, no worktree, no turn — nothing to act on.
    if (agent.status === `draft`) {
        return undefined;
    }
    if (target === `discard`) {
        // The daemon refuses to tear down a worktree that is a running turn's live working state.
        return agent.status === `running` ? undefined : `discard`;
    }
    // Only Finished has actions behind it, and a card already sitting there has nothing left to do.
    if (target !== `finished` || laneOf(agent) === `finished`) {
        return undefined;
    }
    if (agent.status === `running`) {
        return `stop`;
    }
    // Blocked ON THE USER: the agent is mid-task and its work isn't ready to land. Answer it instead.
    if (agent.attention.plan || agent.attention.question || agent.status === `awaiting`) {
        return undefined;
    }
    if (agent.attention.conflict || agent.status === `conflict` || agent.status === `error`) {
        return `land`;
    }
    return undefined;
};

// Why the drop was refused. Worth carrying in the UI because most drops ARE refused: a card that silently
// springs back reads as a bug, and the reason is the only thing that teaches the board's rules.
export const dropRejection = (agent: FleetAgent, target: DropTarget): string | undefined => {
    if (dropActionFor(agent, target) !== undefined) {
        return undefined;
    }
    if (agent.status === `draft`) {
        return `This agent hasn't run yet`;
    }
    if (target === `discard`) {
        return `Stop the turn first`;
    }
    if (target === `attention`) {
        return `Agents raise their own attention flags`;
    }
    if (target === `active`) {
        return `Send a message to start a turn`;
    }
    if (laneOf(agent) === `finished`) {
        return `Already finished`;
    }
    // All that reaches here is the blocked-on-the-user guard; every other path lands in a branch above.
    return `Answer the agent first`;
};

// The verb shown on the drag hint while a legal target is hovered.
export const dropActionLabel = (action: DropAction): string =>
    action === `stop` ? `Stop the turn` : action === `land` ? `Land the work` : `Discard this agent`;
