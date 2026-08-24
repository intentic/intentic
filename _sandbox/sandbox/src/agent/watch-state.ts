import type { AgentWatch } from "@intentic/sandbox-contract";
import { cardProjection } from "../agents/card-projection.js";

/* WHAT THE FLEET CARD SAYS ABOUT THIS CONVERSATION'S ARMED WATCHES, the live half of watchers.ts, kept here
 * and nowhere else.
 *
 * The mechanism (an import-light map the registry reads by call, with a change notification) is
 * card-projection.ts; this is only the watches' use of it, and it is a leaf for the reason that file gives:
 * watchers.ts reaches the steering registry and the detached-turn door, so the agents registry cannot import it
 * without closing a cycle on its way round.
 *
 * THE CHANGE NOTIFICATION EARNS ITS PLACE HERE MORE THAN ANYWHERE ELSE IT IS USED. Every transition of a watch
 * happens BETWEEN turns by definition, that is what a watch is for: armed at the end of one turn, fired or
 * timed out hours later with nothing else moving on the board. Without the notification a card would go on
 * advertising a watch that fired at 3am until some unrelated agent happened to broadcast the roster.
 *
 * THE EMPTY ARRAY IS THE CLEARED STATE, and it is published rather than skipped, unlike a finished loop, which
 * is kept because "stalled after 4" is what its card is read for afterwards. A watch that has fired has nothing
 * left to say: the wake it produced is a turn in the transcript, and a card still naming the condition it was
 * waiting for would be reporting a promise that has already been kept. The registry drops an empty array rather
 * than putting `watches: []` on the wire, so absence stays the signal. */

export const watchProjection = cardProjection<readonly AgentWatch[]>();
