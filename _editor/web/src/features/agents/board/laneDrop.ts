import { awaitingUser, endingByHand, laneOf, type FleetLane, turnInFlight, unregistered, watching } from "../fleet/agentStatus";
import type { FleetAgent } from "../fleet/useAgents-fleet";

// What dragging a card actually does: the lanes are pure projections of the daemon's status machine, so a drop can only
// invoke the action that causes a status change, never assign one. Most drops are refused outright, and both functions
// below walk the same guards in the same order so every refusal explains itself.

// `discard` is not a lane, it's the drop zone the board reveals while a card is in flight.
export type DropTarget = FleetLane | "discard";
export type DropAction = "land" | "resolve" | "stop" | "discard" | "unwatch";

// Every action the board can have in flight against an agent, not just drop actions: a card is equally busy while an
// archive or restore is out. Kept as the action, not a boolean, so a card's own buttons can report their own progress.
export type PendingAction = DropAction | "archive" | "restore" | "reland";

// `resolve` sends a message, needing the conversation the chat singleton holds for one daemon; `unwatch` writes through
// the local fleet store. Stop, land and discard are calls addressed by agent id and work on any sandbox.
const NEEDS_THIS_BOX: ReadonlySet<DropAction> = new Set([`resolve`, `unwatch`]);

// The action this drop would run if the card were in the active sandbox, when that is the only obstacle; both functions
// below read it, so the refusal always names the drop it withheld.
const refusedForItsBox = (agent: FleetAgent, target: DropTarget): string | undefined => {
    const action = dropActionHere(agent, target);
    if (action === undefined || agent.sandboxId === undefined || !NEEDS_THIS_BOX.has(action)) {
        return undefined;
    }
    return action === `resolve` ? `Asking the agent to resolve needs its own sandbox` : `Ending a watch needs the agent's own sandbox`;
};

export const dropActionFor = (agent: FleetAgent, target: DropTarget): DropAction | undefined =>
    refusedForItsBox(agent, target) === undefined ? dropActionHere(agent, target) : undefined;

const dropActionHere = (agent: FleetAgent, target: DropTarget): DropAction | undefined => {
    // A draft or a refused send has no registry entry, no worktree, no turn: nothing for any of these to act on.
    if (unregistered(agent.status)) {
        return undefined;
    }
    if (target === `discard`) {
        // A workspace conversation has no worktree to discard; the daemon also refuses one still in its live turn's
        // working state, including the seconds a stopped turn spends unwinding.
        return agent.branch === undefined || turnInFlight(agent) ? undefined : `discard`;
    }
    // Only Finished has actions behind it; a card already there has nothing left to do.
    if (target !== `finished` || laneOf(agent) === `finished`) {
        return undefined;
    }
    // A turn the user has already ended offers nothing here: the stop it would send has been sent.
    if (endingByHand(agent)) {
        return undefined;
    }
    if (agent.status === `running`) {
        return `stop`;
    }
    // An armed watch is the only reason a card sits in Active, read through the lane machine rather than re-derived,
    // since `blocked()` misreads a bare `conflict` with no flag raised. Excludes `turnInFlight`, so a resuming turn is
    // refused instead.
    if (watching(agent) && laneOf(agent) === `active` && !turnInFlight(agent)) {
        return `unwatch`;
    }
    // Workspace conversations can be stopped and archived, but have no branch to resolve, land or discard.
    if (agent.branch === undefined) {
        return undefined;
    }
    // Blocked on the user: the agent is mid-task, not ready to land. Mirrors agentStatus.awaitingUser.
    if (awaitingUser(agent)) {
        return undefined;
    }
    // A conflicted card's drop asks the agent to resolve rather than re-running the land, which would fail identically
    // since check mode is atomic. The board confirms first (useAgentDrag), since a drag spends a turn on an easy
    // accident.
    if (agent.attention.conflict || agent.status === `conflict`) {
        return `resolve`;
    }
    // An errored, interrupted, or stopped turn never reached its auto-land, so there is a first land to try, not a
    // repeat.
    if (agent.status === `error` || agent.status === `interrupted` || agent.status === `stopped`) {
        return `land`;
    }
    return undefined;
};

// Worth carrying in the UI since most drops are refused; the reason is what teaches the board's rules.
export const dropRejection = (agent: FleetAgent, target: DropTarget): string | undefined => {
    if (dropActionFor(agent, target) !== undefined) {
        return undefined;
    }
    // Ahead of every other reason: the only case where the drop would have worked and the card's sandbox is the whole
    // obstacle.
    const elsewhere = refusedForItsBox(agent, target);
    if (elsewhere !== undefined) {
        return elsewhere;
    }
    if (unregistered(agent.status)) {
        return `This agent hasn't run yet`;
    }
    // Ahead of every target since it's true for all of them; `dismissing` gets the same line as `stopping` since its
    // turn is unwinding too, and "Already finished" would be a beat early.
    if (endingByHand(agent)) {
        return `This turn is already ending`;
    }
    // No turn to stop and nothing to land: the running turn is coming back to this worktree by itself.
    if (agent.status === `resuming`) {
        return `This turn is picking itself back up`;
    }
    // Nothing to stop, and the land it would ask for is the one already under way.
    if (agent.status === `landing`) {
        return `Its work is landing right now`;
    }
    return rejectionForTarget(agent, target);
};

// The half of the refusal that depends on where the card was dropped, once every target-independent reason is ruled out
// above.
const rejectionForTarget = (agent: FleetAgent, target: DropTarget): string => {
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
    // Everything reaching here is the blocked-on-the-user guard; every other path returns above.
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
            : // Names what it ends, not what it "cancels": the promise was to watch, and the drop withdraws it.
              // Same words as the card menu's row, one vocabulary per action.
              action === `unwatch`
              ? `Stop watching`
              : `Discard this agent`;
