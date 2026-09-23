import type { TurnClient } from "../features/chat/session/turnClient";

// A turn standing live in this window with no daemon behind it, in the phase a send's ack or an attach leaves it:
// `startedAt` is what the card's elapsed readout and the board's "newer than the roster" claim count from.
export const runningTurn = (turn: TurnClient, startedAt = Date.now()): void => {
    turn.phase.value = { kind: `running`, controller: new AbortController(), startedAt };
};
