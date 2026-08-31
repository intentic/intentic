import type { Services } from "../composition.js";
import { isIsolated, type PersistedAgent } from "../agents/agents-store.js";
import { anchorWorktree } from "./anchor-worktree.js";
import type { TurnAnchor } from "./turn-anchors.js";

/* WHAT A MESSAGE STEERED INTO A RUNNING TURN CAN GO BACK TO, held from the moment the turn accepts it until the
 * turn settles and the record finally says which row it landed on.
 *
 * A turn's own before-state is filed the instant the turn starts, because that is the instant its index is
 * known: nothing of this turn is in the record yet, so the count IS the position of its opening prompt
 * (sessions/turn-transcript.ts, turnStartIndex). A steered message has neither half of that. The state it needs
 * is the workspace as it stands NOW, mid-answer, which will be gone by the time the turn ends; and its position
 * is unknown until the fold decides how many rows the turn wrote before it. So the two halves are taken at the
 * two moments they exist, and this file is the strap between them.
 *
 * Without it, a message the user typed while the agent worked was the one kind of message with no way back to it
 * at all: no pencil, no rewind, no fork on the files it was written against — permanently, not merely until a
 * reload. Which reads as the affordance being arbitrary, because from the chat's side nothing distinguishes a
 * steered message from a sent one.
 *
 * A BOX IS RESERVED SYNCHRONOUSLY and filled afterwards, and that ordering is the whole reason this is a queue
 * of boxes rather than a queue of anchors. Capturing a state is git and disk; two steers a second apart can
 * finish out of order, and a list that reordered itself would file one message's state under another message's
 * index, which is a rewind restoring the wrong point — the one failure here that loses work rather than
 * declining to act. Positions are fixed at reserve time and never move; a capture that fails, or lands after
 * the turn already settled, leaves its box empty, and an empty box is simply a message with no state behind it,
 * which every surface already draws honestly. */

interface Slot {
    anchor: TurnAnchor | undefined;
}

// conversationId → the boxes for this turn's steers, in the order the turn accepted them.
const reserved = new Map<string, Slot[]>();

// Bound per conversation, so a turn steered at by a runaway script cannot grow this without limit. The far end
// (a turn that settles) empties it; this is only for the turn that never does.
const MAX_PENDING = 200;

/* THE WORKSPACE AS THE STEERED MESSAGE FINDS IT, in whichever currency this conversation's placement has: the
 * same fork the turn's own anchor takes, and for the same reason — what a "state" IS differs between the two
 * placements, so the anchor says which kind it is rather than every reader asking the registry later.
 *
 * Never throws. This runs inside a user gesture the turn has already accepted; a git fault must cost the
 * message its bookmark, not the steer. */
const stateNow = async (
    services: Pick<Services, "agentWorktrees" | "history" | "logger">,
    conversationId: string,
    entry: PersistedAgent,
): Promise<TurnAnchor | undefined> => {
    try {
        if (isIsolated(entry)) {
            // Titled for what it is: this commit sits in the middle of an answer, not at a turn boundary, and a
            // run of "before this turn" commits inside one turn would make the branch's log unreadable.
            const anchored = await anchorWorktree(services, conversationId, entry.repos ?? [], "Agent: before this steered message");
            return anchored.length > 0 ? { kind: "worktree", repos: anchored } : undefined;
        }
        /* The main tree's currency. `snapshot` answers undefined when nothing has changed since the last
         * capture, which mid-turn means the agent has not written yet: the newest existing checkpoint IS this
         * moment's state then, exactly as it is for a turn starting against a clean tree. */
        const id = (await services.history.snapshot("turn")) ?? (await services.history.list())[0]?.id;
        return id === undefined ? undefined : { kind: "tree", snapshot: id };
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "anchors: pinning a steered message failed");
        return undefined;
    }
};

/* TAKE A PLACE IN THE QUEUE, THEN PIN THIS MOMENT INTO IT.
 *
 * The reserve happens before the first `await`, which is to say synchronously in the caller's own tick: that is
 * what pairs the Nth box with the Nth steered row, and it is why this is one call rather than a reserve the
 * route has to remember to make first.
 *
 * A REMOTE conversation takes no box at all, and that is the honest answer rather than a gap: mid-turn the work
 * is on the runner and the mirror here still stands at the state the turn PULLED from, so anchoring it would
 * file a state the steered message was never written against. A wrong state is worse than none — none greys the
 * rows out and says so, wrong restores files the reader never saw. */
export const anchorSteeredMessage = async (
    services: Pick<Services, "agents" | "agentWorktrees" | "history" | "logger">,
    conversationId: string,
): Promise<void> => {
    const slots = reserved.get(conversationId) ?? [];
    if (slots.length >= MAX_PENDING) {
        return;
    }
    /* THE BOX IS TAKEN WHATEVER HAPPENS NEXT, and that is a rule about alignment rather than about bookkeeping.
     * The drain pairs the Nth box with the Nth steered row by position, so a message that declines to be
     * anchored has to leave an EMPTY box rather than no box: skip the box and every later message in the turn
     * shifts up one, which files a state under its neighbour's index — a rewind restoring a point the reader
     * never saw. The cap above is the one safe skip, because it can only ever bite at the tail. */
    const slot: Slot = { anchor: undefined };
    slots.push(slot);
    reserved.set(conversationId, slots);
    const entry = services.agents.entry(conversationId);
    // Nothing to anchor against, or a conversation whose state is on another machine (see above).
    if (entry === undefined || entry.runner !== undefined) {
        return;
    }
    slot.anchor = await stateNow(services, conversationId, entry);
};

// Empty the conversation's queue, in order, for the settle pass that knows the row each box belongs to. Always
// drains: a turn that ended without recording anything must not leave its boxes for the next turn to misread.
export const takeSteerAnchors = (conversationId: string): readonly (TurnAnchor | undefined)[] => {
    const slots = reserved.get(conversationId);
    reserved.delete(conversationId);
    return (slots ?? []).map((slot) => slot.anchor);
};
