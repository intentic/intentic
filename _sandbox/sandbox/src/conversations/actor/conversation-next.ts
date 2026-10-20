import type { AgentNext } from "@intentic/sandbox-contract/schemas/agent-next";
import { breakArmed, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { opt } from "../../opt.js";
import type { Ending, PersistedAgent } from "../registry/agents-store.js";
import { bookedItemsOf, holdOf, NO_QUEUE, type TurnQueue, waitingOf } from "./conversation-queue.js";
import type { ConversationState } from "./conversation-state.js";
import { limitBooking } from "./limit-booking.js";

/* WHAT CARRIES A CONVERSATION ON NEXT WITH NOBODY PRESSING ANYTHING, DERIVED, NEVER KEPT (AgentSummary.next). Read off
   the very facts the movers act on, through the very rules they act by: the resume pass fires a spent allowance's held
   turn by limitBooking, the room release lets a memory hold go by the conversation's answer to the memory wall
   (room-holds.ts), and the booked release sends each message at its own booking (booked-release.ts). The card used to
   carry a copy of the first, written onto the stored ending at the failure and re-synced every beat, and nothing at all
   of the second, so the lane, the corner and the chat each guessed differently (2026-10-07 to 10-19). Now the registry
   asks this every time it projects the card, and a changed answer, a pick, a fire or a drop moves the card with it. */

// The refusals at the door that a moment's wait clears by itself: the sandbox short of memory, and the sandbox too loaded
// to set up the turn's own view of the workspace in time (setup-refusal.ts). Both wait for the same room, and go on the
// conversation's answer to the memory wall.
const ROOM_REFUSALS: ReadonlySet<string> = new Set(["sandbox-memory-low", "workspace-setup"]);

/** Whether the turn a conversation last tried was turned away for room, as its stored ending says. */
export const roomRefused = (ending: Ending | undefined): boolean => ending?.kind === "failed" && ending.code !== undefined && ROOM_REFUSALS.has(ending.code);

/** The conversation's answers to the two walls whose holds go by themselves: its own, else the sandbox's. */
export interface WallAnswers {
    readonly limit: TurnBreakPolicy;
    readonly memory: TurnBreakPolicy;
}

// A spent allowance's held turn, re-run at its reopen or moved now, where the conversation's answer to the limit says so.
const rerunOf = (state: ConversationState, limit: TurnBreakPolicy): AgentNext | undefined => {
    const booking = limitBooking(state.resume.held, limit);
    return booking === undefined ? undefined : { kind: "rerun", at: booking.at, ...opt("onto", booking.moving) };
};

// What a room refusal holds, sent once memory frees where the answer to the memory wall is to send it: the person's
// words a refusal holds in the queue, or a turn the sandbox kept whole at the door.
const roomOf = (state: ConversationState, ending: Ending | undefined, memory: TurnBreakPolicy): AgentNext | undefined => {
    const held = state.resume.held;
    const holding = (holdOf(state.queue) === "refused" && waitingOf(state.queue).length > 0) || (held?.reason === "door" && !held.fired);
    return holding && roomRefused(ending) && breakArmed(memory) ? { kind: "room" } : undefined;
};

// The messages booked for later, each by its own booking: the soonest instant speaks, else the first land waited for.
const bookedOf = (queue: TurnQueue): AgentNext | undefined => {
    const booked = bookedItemsOf(queue);
    const instants = booked.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    if (instants.length > 0) {
        return { kind: "send", at: Math.min(...instants), count: booked.length };
    }
    const after = booked.find((item) => item.after !== undefined)?.after;
    return after === undefined ? undefined : { kind: "land", after: after.conversationId, count: booked.length };
};

/**
 * What carries this conversation on by itself, the held turn first since it is what the ending stopped: its re-run or
 * move, else its memory hold's send, else the soonest message booked for later. Undefined when only a press moves it.
 * A conversation no actor holds yet (one an arrival just brought) holds no turn: only the bookings its entry kept speak.
 */
export const nextOf = (state: ConversationState | undefined, entry: Pick<PersistedAgent, "ending" | "queue">, answers: WallAnswers): AgentNext | undefined =>
    state === undefined
        ? bookedOf(entry.queue ?? NO_QUEUE)
        : (rerunOf(state, answers.limit) ?? roomOf(state, entry.ending, answers.memory) ?? bookedOf(state.queue));
