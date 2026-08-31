/* WHEN A CHAT PICKS ITSELF BACK UP, and when it stops trying to.
 *
 * Continue is a press, and a turn that stops short can happen five times in half an hour, a harness that died
 * mid-run, an agent that halted after a tool it was refused, a runtime whose watchdog cut a stalled turn loose.
 * Each one leaves finished work behind a live session with nothing between it and the rest of the job but
 * somebody saying "carry on", and somebody was pressing the button every time. Armed (Conversation.autoContinue),
 * this presses it for them.
 *
 * THE SCHEDULE IS THE WHOLE DESIGN, because an automation that continues is also an automation that can hammer.
 * Two rules, and they answer the two ways this goes wrong:
 *
 *   The FIRST wait is short. Nearly every stop this arms for is benign, the session is intact and the next turn
 *   picks the work straight up, so a long pause would just be the user waiting for a machine to do what they
 *   would have done immediately. Five seconds is enough to read the strip and press "Turn off" before it fires.
 *
 *   Each wait that BUYS NOTHING is longer than the last, and after three the automation stops and says so. A
 *   turn dying in seconds means something is actually wrong (a provider refusing everything, a session the
 *   runtime cannot resume), and the fastest way to make that expensive is to retry it every five seconds
 *   unattended. Three tries over about a minute is enough for an ordinary transient and far short of a loop.
 *
 *   AN ALLOWANCE WITH NO RESET INSTANT is different. Stopping after a minute abandons the standing instruction
 *   before a five-hour or weekly window could possibly reopen, while repeating the short ladder hammers a gate
 *   whose answer is already known. It gets a long tail instead: seconds first in case the reading was stale,
 *   then minutes, hours, and finally one probe a day. The last rung repeats because there is no better clock to
 *   aim at; once the provider names one, Conversation puts that instant under the wait as a floor.
 *
 * WHAT COUNTS AS BUYING SOMETHING is the turn's own length rather than a reading of the transcript. A turn that
 * ran half a minute did work, it thought, it read files, it wrote some, whatever it stopped on afterwards, and
 * one that died in three seconds did not, whatever it says. Duration is also the honest measure of the thing
 * this is protecting: a fast-failing turn is what makes a retry loop hot, and a slow one paces itself. So a turn
 * past this mark resets the ladder, and an all-night run of long turns keeps its five-second pauses. A usage
 * refusal is the deliberate exception: a harness may spend minutes internally retrying the same closed window,
 * and elapsed time without an answer is not progress. */

// The wait before the Nth ordinary continuation that has bought nothing, and `undefined` past the end of the
// ladder, which is where the automation gives up.
const TRANSIENT_DELAYS_MS = [5_000, 15_000, 45_000] as const;

/* A spent allowance whose provider published no reset. The first three retain the cheap transient recovery;
 * after that every rung changes scale, and the last repeats indefinitely. At the cap an armed chat costs one
 * refused request a day while remaining able to outlive a weekly allowance. */
const UNKNOWN_LIMIT_DELAYS_MS = [
    5_000,
    15_000,
    45_000,
    5 * 60_000,
    30 * 60_000,
    2 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
] as const;

export type AutoContinueBlocker = "transient" | "limit";

export const autoContinueDelay = (triesWithoutProgress: number, blocker: AutoContinueBlocker = "transient"): number | undefined => {
    if (blocker === "limit") {
        return UNKNOWN_LIMIT_DELAYS_MS[Math.min(triesWithoutProgress, UNKNOWN_LIMIT_DELAYS_MS.length - 1)];
    }
    return TRANSIENT_DELAYS_MS[triesWithoutProgress];
};

// How many automatic continuations a chat gets before it has to be pressed by hand, said out loud in the
// notice the last one writes, so the number the user reads is this one.
export const AUTO_CONTINUE_TRIES = TRANSIENT_DELAYS_MS.length;

// A turn this long did some of the job, so the next continuation starts from the front of the ladder again.
export const AUTO_CONTINUE_PROGRESS_MS = 30_000;
