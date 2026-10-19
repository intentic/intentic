import { formatElapsed } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// WHAT A WAIT CAN HONESTLY SAY ABOUT ITSELF. A wait that ends on its own (a sandbox waking, its machine restarting it,
// a reconnect) used to be a spinner and one sentence, and that reads the same at second five as at minute five. It
// never said how long to expect, or when the screen would stop waiting and suggest something else. This file holds
// what such a wait CAN say: how long it has run, how long this kind usually takes, and when the screen gives up and
// offers a way back. Pure, so every sentence is checked without mounting anything (tests/waitProgress.test.ts).
//
// The bar it feeds is an ESTIMATE drawn from `typicalMs` and is never presented as a measurement. It moves quickly
// at first, is about three quarters full at the usual length, and never reaches the end, because only the wait ending
// can complete it.

export interface WaitExpectation {
    /** How much of the wait has passed, on the clock `giveUpMs` is measured on. */
    readonly elapsedMs: number;
    /** How long this kind of wait usually takes. Absent when nothing here can say: it waits on a network or a person. */
    readonly typicalMs?: number | undefined;
    /** When the surface stops calling it a wait and offers something to do. Absent when it never stops by itself. */
    readonly giveUpMs?: number | undefined;
}

// The bar stops short of full: only the wait ending fills it.
const CEILING = 0.95;
// How quickly the bar approaches the ceiling, in units of the usual length: 1.5 puts it about three quarters of the way
// there when the usual length is reached.
const RATE = 1.5;

/** Where the estimated bar sits, 0 to CEILING; undefined when there is no usual length to draw it from. */
export const estimatedShare = (wait: WaitExpectation): number | undefined => {
    const typical = wait.typicalMs;
    if (typical === undefined || !(typical > 0)) {
        return undefined;
    }
    return CEILING * (1 - Math.exp((-RATE * Math.max(0, wait.elapsedMs)) / typical));
};

/** Whether it has run past its usual length, which the words then say rather than keep promising it. */
export const overdue = (wait: WaitExpectation): boolean => wait.typicalMs !== undefined && wait.elapsedMs > wait.typicalMs;

const MINUTE_MS = 60_000;

// A span as the reader is told it: seconds below two minutes when they are not a whole minute ("90 seconds"),
// otherwise whole minutes ("3 minutes"). A rough length is all an estimate needs.
export const spanWords = (ms: number): string => {
    if (ms < 2 * MINUTE_MS && ms % MINUTE_MS !== 0) {
        const seconds = Math.max(5, Math.round(ms / 5_000) * 5);
        return t(`common.waitProgress.seconds`, { count: seconds }, seconds);
    }
    const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
    return t(`common.waitProgress.minutes`, { count: minutes }, minutes);
};

export interface WaitWords {
    /** How long it has run so far ("1m 12s so far"). */
    readonly elapsed: string;
    /** How long it usually takes, or that it is taking longer than that; absent with no usual length. */
    readonly usual: string | undefined;
    /** When the screen stops waiting and says what to do; absent once that time has passed, or if there is none. */
    readonly giveUp: string | undefined;
}

export const waitWords = (wait: WaitExpectation): WaitWords => {
    const elapsed = t(`common.waitProgress.elapsed`, { elapsed: formatElapsed(wait.elapsedMs / 1000) });
    const typical = wait.typicalMs;
    const usual =
        typical === undefined
            ? undefined
            : overdue(wait)
              ? t(`common.waitProgress.longerThanUsual`, { usual: spanWords(typical) })
              : t(`common.waitProgress.usually`, { usual: spanWords(typical) });
    const limit = wait.giveUpMs;
    const giveUp = limit === undefined || wait.elapsedMs >= limit ? undefined : t(`common.waitProgress.giveUp`, { limit: spanWords(limit) });
    return { elapsed, usual, giveUp };
};
