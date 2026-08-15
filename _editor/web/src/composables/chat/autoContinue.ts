/* WHEN A CHAT PICKS ITSELF BACK UP, and when it stops trying to.
 *
 * Continue is a press, and a turn that stops short can happen five times in half an hour — a harness that died
 * mid-run, an agent that halted after a tool it was refused, a runtime whose watchdog cut a stalled turn loose.
 * Each one leaves finished work behind a live session with nothing between it and the rest of the job but
 * somebody saying "carry on", and somebody was pressing the button every time. Armed (Conversation.autoContinue),
 * this presses it for them.
 *
 * THE SCHEDULE IS THE WHOLE DESIGN, because an automation that continues is also an automation that can hammer.
 * Two rules, and they answer the two ways this goes wrong:
 *
 *   The FIRST wait is short. Nearly every stop this arms for is benign — the session is intact and the next turn
 *   picks the work straight up — so a long pause would just be the user waiting for a machine to do what they
 *   would have done immediately. Five seconds is enough to read the strip and press "Turn off" before it fires.
 *
 *   Each wait that BUYS NOTHING is longer than the last, and after three the automation stops and says so. A
 *   turn dying in seconds means something is actually wrong (a provider refusing everything, a session the
 *   runtime cannot resume), and the fastest way to make that expensive is to retry it every five seconds
 *   unattended. Three tries over about a minute is enough for a transient and far short of a loop.
 *
 * WHAT COUNTS AS BUYING SOMETHING is the turn's own length rather than a reading of the transcript. A turn that
 * ran half a minute did work — it thought, it read files, it wrote some — whatever it stopped on afterwards, and
 * one that died in three seconds did not, whatever it says. Duration is also the honest measure of the thing
 * this is protecting: a fast-failing turn is what makes a retry loop hot, and a slow one paces itself. So a turn
 * past this mark resets the ladder, and an all-night run of long turns keeps its five-second pauses. */

// The wait before the Nth consecutive continuation that has bought nothing — and `undefined` past the end of the
// ladder, which is where the automation gives up.
const DELAYS_MS = [5_000, 15_000, 45_000] as const;

export const autoContinueDelay = (triesWithoutProgress: number): number | undefined => DELAYS_MS[triesWithoutProgress];

// How many automatic continuations a chat gets before it has to be pressed by hand — said out loud in the
// notice the last one writes, so the number the user reads is this one.
export const AUTO_CONTINUE_TRIES = DELAYS_MS.length;

// A turn this long did some of the job, so the next continuation starts from the front of the ladder again.
export const AUTO_CONTINUE_PROGRESS_MS = 30_000;
