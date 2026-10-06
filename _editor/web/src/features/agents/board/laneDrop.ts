import { t } from "@intentic/ui/i18n";
import { awaitingUser, conflictIsYours, endingByHand, laneOf, type FleetLane, turnInFlight, unregistered, watching } from "../fleet/agentStatus";
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

// What a card is waiting on: its own press or drop in flight (`running`, keyed per card by useAgentDrag), or an archive
// or restore batch, which names ids alone and is the active box's only, so another box's card is never in it.
export const pendingOf = (
    agent: Pick<FleetAgent, "id" | "sandboxId" | "archivedAt">,
    running: PendingAction | undefined,
    busy: readonly string[],
): PendingAction | undefined => {
    if (running !== undefined) {
        return running;
    }
    if (agent.sandboxId !== undefined || !busy.includes(agent.id)) {
        return undefined;
    }
    return agent.archivedAt !== undefined ? `restore` : `archive`;
};

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
    return action === `resolve` ? t(`agents.laneDrop.resolveNeedsOwnSandbox`) : t(`agents.laneDrop.unwatchNeedsOwnSandbox`);
};

// What a refused land offers: the agent redoes its own merge, unless nothing is left for it to redo. A blocker held by
// the user's uncommitted work is invisible to the agent's checkout and unreachable by a rebase, so a card holding only
// those offers no drop at all rather than a send the daemon refuses on arrival (agentActions.askAgentToResolve).
const conflictAction = (agent: FleetAgent): DropAction | undefined => (conflictIsYours(agent) ? undefined : `resolve`);

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
    // accident. Withheld when every blocker left is the user's own uncommitted work: a rebase cannot reach a file the
    // agent's checkout can't even see, so the send would be refused the moment it was made.
    if (agent.attention.conflict || agent.status === `conflict`) {
        return conflictAction(agent);
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
        return t(`agents.laneDrop.notRunYet`);
    }
    // Ahead of every target since it's true for all of them; `dismissing` gets the same line as `stopping` since its
    // turn is unwinding too, and "Already finished" would be a beat early.
    if (endingByHand(agent)) {
        return t(`agents.laneDrop.alreadyEnding`);
    }
    // No turn to stop and nothing to land: the running turn is coming back to this worktree by itself.
    if (agent.status === `resuming`) {
        return t(`agents.laneDrop.pickingBackUp`);
    }
    // Nothing to stop, and the land it would ask for is the one already under way.
    if (agent.status === `landing`) {
        return t(`agents.laneDrop.landingNow`);
    }
    return rejectionForTarget(agent, target);
};

// The half of the refusal that depends on where the card was dropped, once every target-independent reason is ruled out
// above.
const rejectionForTarget = (agent: FleetAgent, target: DropTarget): string => {
    if (target === `discard`) {
        return agent.branch === undefined ? t(`agents.laneDrop.noBranchToDiscard`) : t(`agents.laneDrop.stopTurnFirst`);
    }
    if (target === `attention`) {
        return t(`agents.laneDrop.agentsRaiseFlags`);
    }
    if (target === `active`) {
        return t(`agents.laneDrop.sendToStart`);
    }
    if (laneOf(agent) === `finished`) {
        return t(`agents.laneDrop.alreadyFinished`);
    }
    // Two ways to reach here: the blocked-on-the-user guard, and a refusal only the user can clear. The second names
    // the press that works, since it's the one refusal where "ask the agent" is the wrong answer rather than a busy one.
    return conflictIsYours(agent) ? t(`agents.laneDrop.commitFirst`) : t(`agents.laneDrop.answerFirst`);
};

// The verb shown on the drag hint while a legal target is hovered.
export const dropActionLabel = (action: DropAction): string =>
    action === `stop`
        ? t(`agents.laneDrop.stopTurn`)
        : action === `land`
          ? t(`agents.laneDrop.landWork`)
          : action === `resolve`
            ? t(`agents.laneDrop.askResolve`)
            : // Names what it ends, not what it "cancels": the promise was to watch, and the drop withdraws it.
              // Same words as the card menu's row, one vocabulary per action.
              action === `unwatch`
              ? t(`agents.words.stopWatching`)
              : t(`agents.laneDrop.discardAgent`);

// What the ghost promises over a target: the action's verb, or the reason there isn't one.
export const dropHint = (action: DropAction | undefined, dragged: FleetAgent | undefined, over: DropTarget | undefined): string | undefined => {
    if (action !== undefined) {
        return dropActionLabel(action);
    }
    if (dragged === undefined || over === undefined) {
        return t(`agents.laneDrop.dropOnLane`);
    }
    return dropRejection(dragged, over);
};
