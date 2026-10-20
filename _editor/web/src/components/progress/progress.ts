import { formatElapsed } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// HOW FAR ALONG A PIECE OF WORK IS, AND WHAT IT CAN HONESTLY SAY ABOUT ITSELF. The one progress model in the editor:
// a sandbox waking, a press whose work runs for minutes, a commit message being drafted, an update drawn as its steps.
// Each used to keep its own estimator (a wait's curve, a stage card's fraction, the commit field's linear pace), so the
// same minute read as three different promises. Every one of them now hands this file the same few facts and reads the
// same answers back: how long it has run, how long it should take, when the screen stops waiting, and how full a bar
// may be drawn. Pure, so every sentence is checked without mounting anything (tests/progress.test.ts).
//
// The bar is the work's own count when it has one (`measured`: docker's layers, the steps a rebuild has passed). Without
// one it is an ESTIMATE drawn from `expectedMs`, never presented as a measurement: it moves quickly at first, is about
// three quarters full at the expected length, and never reaches the end, because only the work ending can complete it.

/** What a kind of work is expected to do: declared once where it starts (an operation's RunOptions, a gate's wait). */
export interface Expectation {
    /** How long it should take. Absent when nothing here can say: it waits on a network or a person. */
    readonly expectedMs?: number | undefined;
    /** When the surface stops calling it a wait and offers something to do. Absent when it never stops by itself. */
    readonly giveUpMs?: number | undefined;
}

export interface Progress extends Expectation {
    /** How long it has run, on the clock `giveUpMs` is measured on; undefined for work adopted mid-flight, whose start nothing here saw. */
    readonly elapsedMs: number | undefined;
    /** How far along the work's own output says it is, 0 to 1, never decreasing. Absent when it counts nothing. */
    readonly measured?: number | undefined;
}

/** Where a piece of work stands at `now`, from when it began (and ended, if it has) and what was expected of it. */
export const progressAt = (
    run: Expectation & { readonly startedAt: number | undefined; readonly endedAt?: number | undefined; readonly measured?: number | undefined },
    now: number,
): Progress => ({
    elapsedMs: run.startedAt === undefined ? undefined : Math.max(0, (run.endedAt ?? now) - run.startedAt),
    expectedMs: run.expectedMs,
    giveUpMs: run.giveUpMs,
    measured: run.measured,
});

// An estimated bar stops short of full: only the work ending fills it.
const CEILING = 0.95;
// How quickly the estimate approaches the ceiling, in units of the expected length: 1.5 puts it about three quarters of
// the way there when the expected length is reached.
const RATE = 1.5;

const clamp = (share: number): number => Math.min(1, Math.max(0, share));

/** The estimate alone, 0 to CEILING; undefined with no expected length or no clock to draw it from. */
export const estimatedShare = (progress: Progress): number | undefined => {
    const expected = progress.expectedMs;
    if (expected === undefined || !(expected > 0) || progress.elapsedMs === undefined) {
        return undefined;
    }
    return CEILING * (1 - Math.exp((-RATE * Math.max(0, progress.elapsedMs)) / expected));
};

/** How full the bar is drawn: the work's own count where it has one, else the estimate; undefined when neither exists. */
export const progressShare = (progress: Progress): number | undefined =>
    progress.measured === undefined ? estimatedShare(progress) : clamp(progress.measured);

/** Whether it has run past its expected length, which the words then say rather than keep promising it. */
export const overdue = (progress: Progress): boolean =>
    progress.expectedMs !== undefined && progress.elapsedMs !== undefined && progress.elapsedMs > progress.expectedMs;

/** Whether it has run to its give-up time: from here a surface offers something to do instead of waiting on. */
export const gaveUp = (progress: Progress): boolean =>
    progress.giveUpMs !== undefined && progress.elapsedMs !== undefined && progress.elapsedMs >= progress.giveUpMs;

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

export interface ProgressWords {
    /** How long it has run so far ("1m 12s so far"); absent when nothing saw it start. */
    readonly elapsed: string | undefined;
    /** How long it should take, or that it is taking longer than that; absent with no expected length. */
    readonly usual: string | undefined;
    /** When the screen stops waiting and says what to do; absent once that time has passed, or if there is none. */
    readonly giveUp: string | undefined;
}

export const progressWords = (progress: Progress): ProgressWords => {
    const elapsed =
        progress.elapsedMs === undefined ? undefined : t(`common.waitProgress.elapsed`, { elapsed: formatElapsed(progress.elapsedMs / 1000) });
    const expected = progress.expectedMs;
    const usual =
        expected === undefined
            ? undefined
            : overdue(progress)
              ? t(`common.waitProgress.longerThanUsual`, { usual: spanWords(expected) })
              : t(`common.waitProgress.usually`, { usual: spanWords(expected) });
    const limit = progress.giveUpMs;
    const giveUp = limit === undefined || gaveUp(progress) ? undefined : t(`common.waitProgress.giveUp`, { limit: spanWords(limit) });
    return { elapsed, usual, giveUp };
};

// A wait most cases of which end in a moment (a reconnect, a first frame) says how long it has run only once it has
// outlasted one: "Reconnecting…" read the same after five seconds as after five minutes, and only the second is worth a
// look, while a counter on every blip would be noise.
const SAY_ELAPSED_AFTER_MS = 5_000;

/** How long it has run ("1m 5s"), once it has outlasted a blip; undefined before then and with no clock. */
export const elapsedWords = (progress: Progress | undefined): string | undefined =>
    progress?.elapsedMs === undefined || progress.elapsedMs < SAY_ELAPSED_AFTER_MS ? undefined : formatElapsed(progress.elapsedMs / 1000);
