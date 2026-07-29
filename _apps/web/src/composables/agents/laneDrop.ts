import { laneOf, type FleetLane } from "./agentStatus";
import type { FleetAgent } from "./useAgents";

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
export type DropAction = "land" | "resolve" | "stop" | "discard";

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
    if (agent.attention.plan || agent.attention.question || agent.attention.permission || agent.status === `awaiting`) {
        return undefined;
    }
    /* A CONFLICTED card's drop asks the agent to resolve it, and does NOT re-run the land.
     *
     * The land is what already failed — check mode is atomic, so pressing it again against an unchanged
     * workspace fails identically — and the board's answer to that was a notice telling the user to go and
     * open the agent. So the one gesture the board offered for a conflict was, in the ordinary case, a
     * guaranteed no-op that ended by sending the user somewhere else. Asking the agent to rebase and resolve
     * in its own worktree is the action that actually finishes the drop's promise: the auto-land at turn
     * completion is what moves the card to Finished. It spends a turn, so the board confirms it first
     * (useAgentDrag) — the drop is a gesture, and a gesture is easier to make by accident than a button. */
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `resolve`;
    }
    // An ERRORED turn never reached its auto-land at all, so there is a first land to try here, not a repeat.
    // Nor did an INTERRUPTED one — its daemon died before the land ran — and whatever it had written by then
    // is sitting in its worktree with nothing else offering to take it.
    if (agent.status === `error` || agent.status === `interrupted`) {
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
    action === `stop`
        ? `Stop the turn`
        : action === `land`
          ? `Land the work`
          : action === `resolve`
            ? `Ask the agent to resolve it`
            : `Discard this agent`;
