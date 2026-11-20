import { poolPace } from "./usagePace";

// The pace tick reads a pool against its own window: the share of the window still to run is where an even spend would
// have the fill, and only a rate that would empty the pool before it resets earns words.

const HOUR = 3_600;
const WEEK = 7 * 24 * HOUR;
const NOW = 1_800_000_000_000; // ms
const at = (secondsFromNow: number): number => NOW / 1000 + secondsFromNow;
const weekly = (percent: number, resetsIn: number, extra: Record<string, unknown> = {}) => ({
    kind: `seven_day`,
    percent,
    resetsAt: at(resetsIn),
    ...extra,
});

describe(`poolPace`, () => {
    it(`marks the share of the window still to run`, () => {
        // Two days into a seven-day week: an even spend leaves 5/7.
        expect(poolPace(weekly(10, 5 * 24 * HOUR), NOW)?.mark).toBeCloseTo((100 * 5) / 7);
    });

    it(`says when a pool runs out before it resets, at the rate spent so far`, () => {
        // A day in, half gone: the other half lasts one more day, well before the reset six days out.
        const pace = poolPace(weekly(50, 6 * 24 * HOUR), NOW);
        expect(pace?.runsOutAt).toBe(at(24 * HOUR));
    });

    it(`stays quiet on a pool spending slower than its window`, () => {
        expect(poolPace(weekly(10, 3 * 24 * HOUR), NOW)?.runsOutAt).toBeUndefined();
    });

    it(`reads a stated period over the pool's words`, () => {
        // A five-hour window whose key names no length: two hours in, three to run.
        expect(poolPace({ kind: `session`, periodSeconds: 5 * HOUR, percent: 20, resetsAt: at(3 * HOUR) }, NOW)?.mark).toBeCloseTo(60);
    });

    it(`draws nothing when there is no clock to read it against`, () => {
        expect(poolPace({ kind: `seven_day`, percent: 30, resetsAt: undefined }, NOW)).toBeUndefined();
        expect(poolPace({ kind: `credits`, percent: 30, resetsAt: at(HOUR) }, NOW)).toBeUndefined();
    });

    it(`draws nothing for a spent, lapsed or unreported pool`, () => {
        expect(poolPace(weekly(100, 3 * 24 * HOUR), NOW)).toBeUndefined();
        expect(poolPace(weekly(30, 3 * 24 * HOUR, { lapsedAt: at(-HOUR) }), NOW)).toBeUndefined();
        expect(poolPace(weekly(30, 3 * 24 * HOUR, { missingSince: at(-HOUR) }), NOW)).toBeUndefined();
    });

    it(`draws nothing for a reset further off than one window, which means a misread length`, () => {
        expect(poolPace(weekly(30, WEEK + HOUR), NOW)).toBeUndefined();
    });

    it(`waits for the window to settle before projecting a run-out`, () => {
        // Six hours into the week: the tick is drawn, but one heavy turn must not read as the week gone by Tuesday.
        const pace = poolPace(weekly(20, WEEK - 6 * HOUR), NOW);
        expect(pace?.mark).toBeGreaterThan(95);
        expect(pace?.runsOutAt).toBeUndefined();
        // Minutes in, not even the tick: it would sit on the bar's end.
        expect(poolPace(weekly(1, WEEK - 60), NOW)).toBeUndefined();
    });
});
