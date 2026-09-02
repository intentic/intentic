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
    /** When the allowance the failure named is due to reopen (ms). Only a spent allowance knows one. */
    readonly readyAt?: number;
    /** Something OTHER than this window is already bringing the turn back, and when (ms). */
    readonly automatic?: { readonly at: number };
    /* THE DAEMON IS HOLDING THE TURN ITSELF, so the press RE-RUNS it rather than sending a message after it
     * (AgentEvent's error `held` has the whole argument). `ran` says whether the held turn got anywhere before it
     * was refused, which is the difference between two sentences the strip could not previously tell apart: it
     * said "the work so far is still here" over every spent allowance, including the overwhelmingly common one
     * that refused the turn's first request and left no work at all. */
    readonly held?: { readonly ran: boolean };
}

/* Past this far out a wall-clock time reads better than a countdown: a weekly allowance resets on Tuesday, and
 * "about 4300 min" is a number nobody can act on. Under it the relative wait wins, for the reason formatWait
 * gives: an outage retry expressed as a clock time makes the reader do arithmetic. */
const CLOCK_FROM_MS = 90 * 60 * 1_000;

/* WHETHER TO OFFER THE PRESS AT ALL, which used to be "has the reset instant passed" and is now very nearly
 * always yes.
 *
 * A HELD TURN IS ALWAYS PRESSABLE, whatever the reset says, and withholding it was the most expensive small
 * decision in this file. The reasoning was sound on its own terms, a press before the allowance reopens only
 * re-fails, so the button was disabled until then. What it did not account for is that the composer is right
 * there: a user looking at a dead button and an eight-hour countdown types the word themselves, which used to run
 * the same send with none of the gate's benefit, and one real transcript did it four times in sixty-five seconds
 * before the fifth got through, eight hours before the reset the notice had promised. The gate never prevented a
 * request. It only chose the worse of the two ways to make one.
 *
 * With the turn held, a press that re-fails costs one refused request and adds nothing to the conversation
 * (turn-resume.ts's fireLimitResume is idempotent by construction), so there is nothing left to protect the user
 * from, and the reset instant goes back to being what it always honestly was: information, in the sentence,
 * rather than a promise the button is staked on. The wait still gates the endings with nothing held, where a
 * press really would just append. */
export const pickUpReady = (pickUp: PickUp, now: number = Date.now()): boolean =>
    pickUp.held !== undefined || pickUp.readyAt === undefined || pickUp.readyAt <= now;

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
/* WHAT IS BRINGING THIS TURN BACK, AND WHY, when something other than the user is: two waits that look alike on
 * screen and are not the same promise.
 *
 * An OUTAGE retry is a guess at a provider nobody can predict, which is what the attempt count is apologising
 * for: the automation is spending the user's allowance while they watch, so it accounts for itself out loud or
 * the reasonable response is to switch it off.
 *
 * A LIMIT's is an APPOINTMENT. The hour came from the provider, the fire happens once, and there is nothing to
 * keep trying, so there is no count to spend and no failure to report: opening this sentence with "the provider
 * failed this turn" would be wrong twice over about a provider that was working perfectly and said so. */
const automaticLine = (reason: PickUpReason, at: number, attempts: PickUpAttempts | undefined, now: number): string => {
    if (reason === `limit`) {
        return `The allowance was spent, and this chat sends the turn again by itself when it comes back ${pickUpWhen(at, now)}. Sending it sooner works too.`;
    }
    const counted = attempts === undefined ? `` : ` Attempt ${attempts.attempt} of ${attempts.maxAttempts}.`;
    return `The provider failed this turn and this chat picks it back up by itself ${pickUpWhen(at, now)}.${counted} Continuing it yourself works too.`;
};

export const pickUpLine = (pickUp: PickUp, attempts: PickUpAttempts | undefined, now: number = Date.now()): string => {
    if (pickUp.automatic !== undefined) {
        return automaticLine(pickUp.reason, pickUp.automatic.at, attempts, now);
    }
    if (pickUp.reason === `outage`) {
        return `The provider failed this turn and nothing is retrying it: the work so far is still here.`;
    }
    if (pickUp.reason === `limit`) {
        /* THE TWO SHAPES A SPENT ALLOWANCE COMES IN, which this said one sentence about for as long as it had
         * one sentence to say. "The allowance ran out mid-turn: the work so far is still here" is true of a limit
         * reached in flight and false twice over of the commoner one, the allowance that was already spent and
         * refused the turn's first request: nothing ran, and there is no work so far to still be here. Saying it
         * anyway is how a reader comes to distrust the line that is also telling them when to come back.
         *
         * The reset instant is stated, never promised. It is the provider's own guess at when the window
         * reopens and it is routinely wrong in the useful direction, so it rides as "not before", with the press
         * live regardless (see pickUpReady) rather than held behind it. */
        const opening = pickUp.held?.ran === false ? `The allowance was spent, so this never ran` : `The allowance ran out mid-turn: the work so far is still here`;
        return pickUp.readyAt === undefined || pickUp.readyAt <= now
            ? `${opening}. Sending it again is one press.`
            : `${opening}. The allowance is due back ${pickUpWhen(pickUp.readyAt, now)}; sending it again before that may still get through.`;
    }
    return `This turn stopped before it finished: the work so far is still here.`;
};
