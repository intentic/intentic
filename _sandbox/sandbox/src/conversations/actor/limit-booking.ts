import { breakArmed, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import type { HeldRecord } from "./conversation-state.js";

/* WHETHER A SPENT ALLOWANCE'S HELD TURN GOES AGAIN BY ITSELF, AND WHEN: ONE RULE FOR EVERYTHING THAT SAYS SO. The resume
   pass fires by it (limit-due.ts, through turn-resume.ts runLimitHold), the failure frame states it (classify-failure.ts
   limitFrame), and the card's `next` is derived from it every time the card is read (conversation-next.ts), so a card is
   in Active exactly when this rule says something will send it. Its inputs are facts on the hold (its reopen, a booked
   move, a person's pick, the wall in front of where it goes as the pass last read it) and the conversation's answer to
   the limit: never a copy of its own output. Before 2026-10-20 that output was copied onto the stored ending at the
   failure and re-synced by the pass every beat, and every path that changed a hold or its answer between beats left the
   card saying what the pass would no longer do. */

/**
 * How long after an allowance's reset the sandbox waits before sending into it by itself. A reset is the provider's own
 * clock, and a request sent the instant it names can land before the provider has turned the window over: at
 * 2026-10-26 00:00:00 two Codex turns booked for that reset were refused within three seconds ("try again at 11:59 PM"),
 * and one lost its summary hand-off on that refusal; the same allowance served both a minute or two later. A person's
 * own press still goes the moment they press it.
 */
export const RESET_GRACE_MS = 60_000;

/** The instant (ms) the sandbox's own sends may go into an allowance that reopens at `reopensAt` (epoch seconds). */
export const sendableAt = (reopensAt: number): number => reopensAt * 1000 + RESET_GRACE_MS;

/**
 * The reopen (epoch seconds) of a hold due at `now` (ms) rather than at any provider's reset: one whose grace runs out
 * within the second, so sendableAt reads it as now. A pick onto an account with room is due at once, not a grace later.
 */
export const reopenedBy = (now: number): number => Math.ceil((now - RESET_GRACE_MS) / 1000);

/**
 * The instant (ms) a limit hold goes at its reset, the grace after it, or undefined: none named, or one already past
 * when it was refused, which would only loop. A refusal inside the grace is the provider's clock not yet turned over,
 * and goes once more when the grace is out.
 */
export const heldReopensAt = (held: { readonly reopensAt?: number | undefined; readonly recordedAt: number }): number | undefined => {
    const at = held.reopensAt === undefined ? undefined : sendableAt(held.reopensAt);
    return at === undefined || at <= held.recordedAt ? undefined : at;
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
 * The hold's `walledUntil` (ms) is when the allowance in front of where it would go reopens, where the records called
 * that account spent when the pass last read it (limit-due.ts). It only ever pushes a booking later, never books a hold
 * that has none: a hold left untimed on purpose (a child past its horizon) stays a press's. The instant stored on the
 * hold is judged once, when the refusal or a pick made it: a pick that judged a spent account open stored "now", and
 * the next beat sent the turn to be refused (2026-10-19).
 */
export const limitBooking = (held: HeldRecord | undefined, policy: TurnBreakPolicy): LimitBooking | undefined => {
    if (held?.reason !== "limit" || held.fired || !breakArmed(policy)) {
        return undefined;
    }
    const booked = held.move !== undefined && policy === "move" ? { at: held.recordedAt, moving: held.move.account } : timedBooking(held);
    const wall = held.walledUntil;
    return booked === undefined || wall === undefined || wall <= booked.at ? booked : { ...booked, at: wall };
};

const timedBooking = (held: HeldRecord): LimitBooking | undefined => {
    const at = heldReopensAt(held);
    return at === undefined ? undefined : { at };
};
