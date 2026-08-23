import { formatReset, formatWait } from "./usageStatus";

/* A TURN WORTH PICKING BACK UP, one state for every ending that leaves finished work behind a live session.
 *
 * There used to be three answers to the same situation, and they agreed about nothing. A turn that died with no
 * name got the continue strip and the Enter shortcut. A provider outage got a banner of its own, in another
 * component, with its own countdown and its own pair of buttons. A spent allowance got a muted sentence and
 * NOTHING else, on the grounds that a press before the reset only re-fails, which is true, and which quietly
 * left the one ending that knows exactly when the press WOULD work as the only one that made the user type the
 * word by hand.
 *
 * So the question is asked once and answered as data. `reason` is the sentence, `readyAt` is the honest "not
 * before this" a spent allowance can state and the others cannot, and `automatic` is the one thing that changes
 * what the affordance MEANS: somebody else is already bringing this turn back, so the strip reports a wait
 * rather than offering one, and the local auto-continue keeps its hands off it.
 *
 * Deliberately absent from the endings that name a fix, a dead credential, a model the provider doesn't serve,
 * a seat nobody enabled. Those re-fail on the press by construction, and an offer that re-fails is worse than
 * no offer: it converts a clear refusal into one the user now blames themselves for. */

export type PickUpReason = `stopped` | `limit` | `outage`;

export interface PickUp {
    /** Which ending left the work here, read only for the sentence. */
    readonly reason: PickUpReason;
    /** Nothing gets through before this instant (ms). Only a spent allowance knows one; the press waits for it. */
    readonly readyAt?: number;
    /** Something OTHER than this window is already bringing the turn back, and when (ms). */
    readonly automatic?: { readonly at: number };
}

/* Past this far out a wall-clock time reads better than a countdown: a weekly allowance resets on Tuesday, and
 * "about 4300 min" is a number nobody can act on. Under it the relative wait wins, for the reason formatWait
 * gives: an outage retry expressed as a clock time makes the reader do arithmetic. */
const CLOCK_FROM_MS = 90 * 60 * 1_000;

/** Whether a press would get through now, or is still waiting on the instant the pick-up named. */
export const pickUpReady = (pickUp: PickUp, now: number = Date.now()): boolean => pickUp.readyAt === undefined || pickUp.readyAt <= now;

/** An instant as the strip says it: a countdown while it is close, a weekday and time once it isn't. */
const pickUpWhen = (at: number, now: number = Date.now()): string =>
    at - now >= CLOCK_FROM_MS ? `at ${formatReset(Math.round(at / 1_000))}` : `in ${formatWait(Math.round(at / 1_000), now)}`;

/** How many tries the thing bringing this turn back has left, when it is the daemon's outage breaker. */
export interface PickUpAttempts {
    readonly attempt: number;
    readonly maxAttempts: number;
}

/* WHAT THE STRIP SAYS, one sentence per situation, here rather than in the template so the wording is testable
 * without mounting a chat and so the four cases cannot drift apart the way three components did.
 *
 * Every one of them leads with the fact that decides whether to read on, the work so far is still here, and
 * only then says what is or isn't happening about it. */
export const pickUpLine = (pickUp: PickUp, attempts: PickUpAttempts | undefined, now: number = Date.now()): string => {
    if (pickUp.automatic !== undefined) {
        // The automation spending the user's allowance while they watch has to account for itself, or the
        // reasonable response is to switch it off: hence the bound, said out loud, every time.
        const counted = attempts === undefined ? `` : ` Attempt ${attempts.attempt} of ${attempts.maxAttempts}.`;
        return `The provider failed this turn and this chat picks it back up by itself ${pickUpWhen(pickUp.automatic.at, now)}.${counted} Continuing it yourself works too.`;
    }
    if (pickUp.reason === `outage`) {
        return `The provider failed this turn and nothing is retrying it: the work so far is still here.`;
    }
    if (pickUp.reason === `limit`) {
        /* The one ending that can promise a working press, and the whole reason this file exists. Before the
         * reset the strip is a countdown rather than a dead button: the press is coming, and saying WHEN is the
         * difference between waiting and giving up. */
        return pickUpReady(pickUp, now)
            ? `The allowance ran out mid-turn: the work so far is still here.`
            : `The allowance ran out mid-turn: the work so far is still here, and it carries on ${pickUpWhen(pickUp.readyAt!, now)}, when the allowance resets.`;
    }
    return `This turn stopped before it finished: the work so far is still here.`;
};
