import { breakArmed, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { HeldRecord } from "./conversation-state.js";

/* WHETHER A SPENT ALLOWANCE'S HELD TURN GOES AGAIN BY ITSELF, AND WHEN: ONE RULE FOR EVERYTHING THAT SAYS SO. The resume
   pass fires by it (limit-due.ts, through turn-resume.ts runLimitHold), the failure frame states it (classify-failure.ts
   limitFrame), and the card's `limitScheduled` and `limitNextAt` are projected from it (agents-registry.ts, limit-ending.ts),
   with the wall in front of the account read on the same beat for both. That projection is what files a stranded card
   in Active rather than Attention (agent-lanes.ts laneOf), so a card is in Active exactly when this rule says something
   will send it. Before 2026-10-19 three places decided it from three inputs: the frame from the refusal's reset, a
   changed answer from the stored ending's reset, the pass from the hold's own reopen plus a fresh read of the answer.
   They drifted apart. A child whose reset lay past its horizon read "resends …" in Active after any answer while nothing
   would fire it. A sandbox-wide answer changed in Settings left every held card filed by the old one. An account picked
   mid-hold kept a booking the hold no longer had. The pass now holds the stored booking to this rule on every beat
   (held-standing.ts keepLimitBooking), so whatever path changes a hold or its answer, the card follows within a beat. */

/**
 * The instant (ms) a limit hold goes at its reset, or undefined: none named, or one already past when it was refused,
 * which would only loop.
 */
export const heldReopensAt = (held: { readonly reopensAt?: number | undefined; readonly recordedAt: number }): number | undefined => {
    const reopensAt = held.reopensAt === undefined ? undefined : held.reopensAt * 1000;
    return reopensAt === undefined || reopensAt <= held.recordedAt ? undefined : reopensAt;
};

/** What a held turn does by itself: goes at `at` (ms, possibly past: the next beat), and to `moving` where it moves. */
export interface LimitBooking {
    readonly at: number;
    readonly moving?: string;
}

/**
 * What an unfired spent-allowance hold does by itself under `policy`, the conversation's answer to the limit: a booked
 * move at once while that answer is still to move, else its reset under any answer that sends. Undefined when only a
 * press sends it: no hold, a fired one, another kind of hold, an answer to wait, or no reset to go at.
 *
 * `wallUntil` (ms) is when the allowance in front of where it would go reopens, where the records call that account
 * spent now (limit-due.ts reads it on every beat). It only ever pushes a booking later, never books a hold that has
 * none: a hold left untimed on purpose (a child past its horizon) stays a press's. The instant stored on the hold was
 * judged once, when the refusal or a pick made it, and was trusted from then on: a pick that judged a spent account open
 * stored "now", and the next beat sent the turn to be refused (2026-10-19). Absent where nobody read the wall (an answer
 * changed in Settings, agents-registry.ts): the stored instant stands until the next beat reads it.
 */
export const limitBooking = (held: HeldRecord | undefined, policy: TurnBreakPolicy, wallUntil?: number): LimitBooking | undefined => {
    if (held?.reason !== "limit" || held.fired || !breakArmed(policy)) {
        return undefined;
    }
    const booked = held.move !== undefined && policy === "move" ? { at: held.recordedAt, moving: held.move.account } : timedBooking(held);
    return booked === undefined || wallUntil === undefined || wallUntil <= booked.at ? booked : { ...booked, at: wallUntil };
};

const timedBooking = (held: HeldRecord): LimitBooking | undefined => {
    const at = heldReopensAt(held);
    return at === undefined ? undefined : { at };
};
