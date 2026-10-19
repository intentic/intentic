import { breakArmed, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { HeldRecord } from "./conversation-state.js";

/* WHETHER A SPENT ALLOWANCE'S HELD TURN GOES AGAIN BY ITSELF, AND WHEN: ONE RULE FOR EVERYTHING THAT SAYS SO. The resume
   pass fires by it (turn-resume.ts RUNGS.limit and runRung), the failure frame states it (classify-failure.ts limitFrame),
   and the card's `limitScheduled` is projected from it (agents-registry.ts). That projection is what files a stranded card
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
export const limitReopensAt = (held: { readonly reopensAt?: number | undefined; readonly recordedAt: number }): number | undefined => {
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
 */
export const limitBooking = (held: HeldRecord | undefined, policy: TurnBreakPolicy): LimitBooking | undefined => {
    if (held?.reason !== "limit" || held.fired || !breakArmed(policy)) {
        return undefined;
    }
    if (held.move !== undefined && policy === "move") {
        return { at: held.recordedAt, moving: held.move.account };
    }
    const at = limitReopensAt(held);
    return at === undefined ? undefined : { at };
};
