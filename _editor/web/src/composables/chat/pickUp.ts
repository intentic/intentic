import type { TurnEnding } from "@intentic/sandbox-contract";
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

/* THE SAME STATE, AS THE DAEMON HAS IT (AgentTranscriptSchema.ending), for every window that did not watch the
 * turn die: a reload, another device, a tab reopened from the board, a Stop pressed with the chat closed.
 *
 * The two halves are the same answer arrived at from either end, which is why this is a projection rather than
 * a second reading: the stream builds a pick-up from the failure frame (turnFailures.ts) and the record builds
 * the identical one from what the daemon kept. Only the units differ — the wire counts seconds like every other
 * instant the daemon publishes, the client counts milliseconds like every other instant it compares to
 * Date.now() — and folding that here is what keeps the conversion out of the four surfaces downstream.
 *
 * `scheduled` becomes `automatic` only WITH an instant to aim at, the same guard armLimitResume applies at the
 * other end: a booking with no hour is not an appointment, and a countdown to nothing would replace a live press
 * with a promise nobody can keep. */
export const pickUpOf = (ending: TurnEnding): PickUp => {
    const readyAt = ending.resetsAt === undefined ? undefined : ending.resetsAt * 1_000;
    return {
        reason: ending.reason,
        ...(readyAt === undefined ? {} : { readyAt }),
        ...(ending.held === undefined ? {} : { held: { ran: ending.held.ran } }),
        ...(ending.scheduled === true && readyAt !== undefined ? { automatic: { at: readyAt } } : {}),
    };
};

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

/* WHAT THE STRIP SAYS, one short line per situation, here rather than in the template so the wording is
 * testable without mounting a chat and so the four cases cannot drift apart the way three components did.
 *
 * A STATUS, NOT A PARAGRAPH, and that is the whole of what changed. This used to be prose: what stopped the
 * turn, that the work survived, when the allowance was due back, and a hedge about pressing sooner anyway,
 * three clauses wrapping to two lines beside four buttons of equal weight. None of it is what someone refused
 * mid-thought is reading for. They are looking for the way on, and every word in front of it is in the way.
 *
 * So the line carries the three facts that change what a person does, in the order they want them:
 *
 *   WHAT HAPPENED   Limit reached · Provider failed · Turn stopped short
 *   WHAT SURVIVED   work kept, or nothing ran, the one thing a reader cannot check for themselves
 *   WHEN            back at Fri 01:50 · retrying in about 2 min · sending again at Fri 01:50
 *
 * Nothing the prose knew has been dropped, the parts that are ABOUT A CONTROL moved onto that control, where
 * they are read at the moment they matter rather than re-read on every failure: that the reset is a due date
 * and not a wall now rides the press's own tooltip, and what arming buys rides the button that arms it. */

// How many tries the thing bringing this turn back has left, spent out loud for the reason the outage's own
// line gives: an automation spending the user's allowance while they watch has to account for itself.
const attemptsSaid = (attempts: PickUpAttempts | undefined): string =>
    attempts === undefined ? `` : ` · try ${attempts.attempt} of ${attempts.maxAttempts}`;

/* WHAT IS BRINGING THIS TURN BACK, when something other than the user is: two waits that look alike on screen
 * and are not the same promise.
 *
 * An OUTAGE retry is a guess at a provider nobody can predict, which is what the attempt count is for. A
 * LIMIT's is an APPOINTMENT: the hour came from the provider, the fire happens once, there is nothing to keep
 * trying, so there is no count to spend and no failure to report. Saying "provider failed" over that would be
 * wrong twice over about a provider that was working perfectly and said so. */
const automaticStatus = (reason: PickUpReason, at: number, attempts: PickUpAttempts | undefined, now: number): string =>
    reason === `limit`
        ? `Limit reached · sending again ${pickUpWhen(at, now)}`
        : `Provider failed · retrying ${pickUpWhen(at, now)}${attemptsSaid(attempts)}`;

export const pickUpStatus = (pickUp: PickUp, attempts: PickUpAttempts | undefined, now: number = Date.now()): string => {
    if (pickUp.automatic !== undefined) {
        return automaticStatus(pickUp.reason, pickUp.automatic.at, attempts, now);
    }
    if (pickUp.reason === `outage`) {
        return `Provider failed · work kept`;
    }
    if (pickUp.reason === `limit`) {
        /* THE TWO SHAPES A SPENT ALLOWANCE COMES IN, which this said one thing about for as long as it had one
         * thing to say. "Work kept" is true of a limit reached in flight and false of the commoner one, the
         * allowance already spent when the turn's first request went out: nothing ran, and there is no work to
         * keep. Claiming it anyway is how a reader comes to distrust the same line's answer about when to come
         * back.
         *
         * The reset instant is STATED, never promised, hence "back at" rather than "not before". It is the
         * provider's own guess at when the window reopens and it is routinely wrong in the useful direction,
         * which is why the press stays live in front of it (pickUpReady) and why the caveat lives on the press
         * rather than here. */
        const survived = pickUp.held?.ran === false ? `nothing ran` : `work kept`;
        const due = pickUp.readyAt === undefined || pickUp.readyAt <= now ? `` : ` · back ${pickUpWhen(pickUp.readyAt, now)}`;
        return `Limit reached · ${survived}${due}`;
    }
    return `Turn stopped short · work kept`;
};
