import { awaitingUser, endingByHand, laneOf, type FleetLane, turnInFlight, unregistered, watching } from "./agentStatus";
import type { FleetAgent } from "./useAgents";

/* What dragging a card across the board actually DOES. The lanes are pure projections of the daemon's status
 * machine (laneOf), so a drop cannot assign a status, it can only invoke the action that CAUSES one, and only
 * some drops have an action behind them. Everything else is refused: the lane never lights up and the card
 * springs back. That is the honest answer, not a missing feature, there is no way to make an agent "be
 * running" without sending it a message, and no way to manufacture a pending question on its behalf.
 *
 * Both functions below walk the same guards in the same order, so the refusal always explains the refusal that
 * actually happened. */

// `discard` is not a lane, it's the drop zone the board reveals while a card is in flight.
export type DropTarget = FleetLane | "discard";
export type DropAction = "land" | "resolve" | "stop" | "discard" | "unwatch";

/* WHAT A CARD IS WAITING ON, every action the board can have in flight against one agent, not just the ones a
 * drop invokes: a card is equally busy while this browser's archive or restore is out.
 *
 * It is the action and not a boolean because the two actions the card offers as BUTTONS report their own
 * progress in place (AgentCard), and a flag cannot tell them apart from the filing pair, archiving a `ready`
 * card would otherwise leave its Land button spinning on work nobody asked to land. */
export type PendingAction = DropAction | "archive" | "restore" | "reland";

export const dropActionFor = (agent: FleetAgent, target: DropTarget): DropAction | undefined => {
    // A draft is an open tab that never ran, and a refused one is a tab that TRIED and was turned away: either
    // way there is no registry entry, no worktree and no turn, nothing for any of these to act on.
    if (unregistered(agent.status)) {
        return undefined;
    }
    if (target === `discard`) {
        // A workspace conversation has no worktree to tear down at all; and the daemon refuses one that is a
        // live turn's working state, including the seconds a stopped turn spends unwinding, which is exactly
        // when a user is most likely to try.
        return agent.branch === undefined || turnInFlight(agent) ? undefined : `discard`;
    }
    // Only Finished has actions behind it, and a card already sitting there has nothing left to do.
    if (target !== `finished` || laneOf(agent) === `finished`) {
        return undefined;
    }
    // A turn the user has already ended has nothing to offer this gesture: the stop it would send has been sent.
    if (endingByHand(agent)) {
        return undefined;
    }
    if (agent.status === `running`) {
        return `stop`;
    }
    /* AN ARMED WATCH IS WHAT KEEPS THIS CARD OUT OF FINISHED, so disarming it is the action the drop invokes,
     * exactly as a running turn's drop invokes the stop that ends it. Without this the gesture had no answer
     * at all for the one kind of card the lane change put in its way, and refused it with a sentence about
     * answering an agent that had asked nothing.
     *
     * Ahead of the branch guard, because a watch has nothing to do with a worktree: a workspace conversation
     * arms them exactly as readily as an isolated one, and has no land, resolve or discard to be refused for.
     *
     * The guard is "the watch is the ONLY reason this card is in Active", spelled through the lane machine
     * rather than re-derived here: a watching agent that also errored, conflicted or is holding a question
     * sits in Attention, and the rules below already know what each of those is worth. Asking `blocked()`
     * instead reads almost the same and is wrong on one card, a bare `conflict` status with no flag raised,
     * which laneOf files under Attention and `blocked` does not (see laneOf). One projection, no second
     * opinion. The in-flight exclusion covers `resuming`: that turn is coming back to this worktree on its
     * own, which is what the drop should be refused for, watch or no watch. */
    if (watching(agent) && laneOf(agent) === `active` && !turnInFlight(agent)) {
        return `unwatch`;
    }
    // Workspace conversations can be stopped and archived, but have no branch to resolve, land or discard.
    if (agent.branch === undefined) {
        return undefined;
    }
    // Blocked ON THE USER: the agent is mid-task and its work isn't ready to land. Answer it instead.
    // The same line agentStatus.awaitingUser draws, spelled by that function so the two cannot drift.
    if (awaitingUser(agent)) {
        return undefined;
    }
    /* A CONFLICTED card's drop asks the agent to resolve it, and does NOT re-run the land.
     *
     * The land is what already failed, check mode is atomic, so pressing it again against an unchanged
     * workspace fails identically, and the board's answer to that was a notice telling the user to go and
     * open the agent. So the one gesture the board offered for a conflict was, in the ordinary case, a
     * guaranteed no-op that ended by sending the user somewhere else. Asking the agent to rebase and resolve
     * in its own worktree is the action that actually finishes the drop's promise: the auto-land at turn
     * completion is what moves the card to Finished. It spends a turn, so the board confirms it first
     * (useAgentDrag), the drop is a gesture, and a gesture is easier to make by accident than a button. */
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `resolve`;
    }
    // An ERRORED turn never reached its auto-land at all, so there is a first land to try here, not a repeat.
    // Nor did an INTERRUPTED one, its daemon died before the land ran, nor a STOPPED one, whose land is
    // skipped precisely because half-finished work must not land itself. Whatever each had written by then is
    // sitting in its worktree with nothing else offering to take it.
    if (agent.status === `error` || agent.status === `interrupted` || agent.status === `stopped`) {
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
    if (unregistered(agent.status)) {
        return `This agent hasn't run yet`;
    }
    // Ahead of every target, because it is the true answer for all of them, and because the discard line
    // below would otherwise tell a user who has just stopped this turn to stop it. `dismissing` is the same
    // sentence about the other ending a person chooses: its turn is unwinding too, so nothing here is theirs to
    // press, and "Already finished" (which its lane would otherwise earn it) would be a beat early.
    if (endingByHand(agent)) {
        return `This turn is already ending`;
    }
    // Same placement, same reason: there is no turn here to stop and nothing to land, because the one that was
    // running is coming back to this worktree by itself.
    if (agent.status === `resuming`) {
        return `This turn is picking itself back up`;
    }
    if (target === `discard`) {
        return agent.branch === undefined ? `Workspace conversations have no isolated branch to discard` : `Stop the turn first`;
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
            : // Names what it ends, not what it "cancels": the promise was to wake this conversation, and the
              // drop is the user withdrawing it. Same words as the card menu's row, one vocabulary per action.
              action === `unwatch`
              ? `Stop watching`
              : `Discard this agent`;
