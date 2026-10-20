import { elapsedWords, estimatedShare, gaveUp, overdue, progressAt, progressShare, progressWords, spanWords } from "../progress";

// What a piece of work says about itself, in the one progress model every readout shares. The promises under test: the bar is an estimate that never claims the wait is over,
// the words stop promising the usual length once it has passed, and the give-up sentence disappears the moment it is
// no longer a promise about the future.

describe(`the estimated bar`, () => {
    it(`starts empty, is about three quarters full at the usual length, and never fills`, () => {
        expect(estimatedShare({ elapsedMs: 0, expectedMs: 60_000 })).toBe(0);
        const atUsual = estimatedShare({ elapsedMs: 60_000, expectedMs: 60_000 }) ?? 0;
        expect(atUsual).toBeGreaterThan(0.7);
        expect(atUsual).toBeLessThan(0.8);
        expect(estimatedShare({ elapsedMs: 60 * 60_000, expectedMs: 60_000 })).toBeLessThan(1);
    });

    it(`only moves forward`, () => {
        const shares = [0, 5_000, 20_000, 60_000, 300_000].map((elapsedMs) => estimatedShare({ elapsedMs, expectedMs: 30_000 }) ?? 0);
        expect(shares).toEqual(shares.toSorted((a, b) => a - b));
    });

    it(`is not drawn without a usual length to draw it from`, () => {
        expect(estimatedShare({ elapsedMs: 10_000 })).toBeUndefined();
        expect(estimatedShare({ elapsedMs: 10_000, expectedMs: 0 })).toBeUndefined();
    });
});

describe(`a span, as the reader is told it`, () => {
    it(`counts seconds below two minutes and whole minutes above`, () => {
        expect(spanWords(20_000)).toBe(`20 seconds`);
        expect(spanWords(90_000)).toBe(`90 seconds`);
        expect(spanWords(100_000)).toBe(`100 seconds`);
        expect(spanWords(60_000)).toBe(`1 minute`);
        expect(spanWords(3 * 60_000)).toBe(`3 minutes`);
    });
});

describe(`the words`, () => {
    it(`say how long it has run, how long it usually takes, and when the screen gives up`, () => {
        expect(progressWords({ elapsedMs: 12_000, expectedMs: 60_000, giveUpMs: 3 * 60_000 })).toEqual({
            elapsed: `12s so far`,
            usual: `usually about 1 minute`,
            giveUp: `If it takes more than 3 minutes, we'll show you what you can do.`,
        });
    });

    it(`stop promising the usual length once it has passed`, () => {
        expect(overdue({ elapsedMs: 70_000, expectedMs: 60_000 })).toBe(true);
        expect(progressWords({ elapsedMs: 70_000, expectedMs: 60_000 }).usual).toBe(`longer than the usual 1 minute`);
    });

    it(`drop the give-up sentence once it is no longer about the future`, () => {
        expect(progressWords({ elapsedMs: 3 * 60_000, expectedMs: 60_000, giveUpMs: 3 * 60_000 }).giveUp).toBeUndefined();
    });

    it(`say only how long it has run where nothing can say how long it lasts`, () => {
        expect(progressWords({ elapsedMs: 125_000 })).toEqual({ elapsed: `2m 5s so far`, usual: undefined, giveUp: undefined });
    });

    it(`say nothing about time for work adopted mid-flight, whose start nothing saw`, () => {
        expect(progressWords({ elapsedMs: undefined, expectedMs: 60_000 })).toEqual({ elapsed: undefined, usual: `usually about 1 minute`, giveUp: undefined });
        expect(overdue({ elapsedMs: undefined, expectedMs: 1 })).toBe(false);
    });
});

describe(`one bar for every kind of work`, () => {
    it(`draws the work's own count where it keeps one, and the estimate only where it does not`, () => {
        expect(progressShare({ elapsedMs: 1_000, expectedMs: 60_000, measured: 0.6 })).toBe(0.6);
        expect(progressShare({ elapsedMs: undefined, measured: 1.4 })).toBe(1);
        expect(progressShare({ elapsedMs: 60_000, expectedMs: 60_000 })).toBe(estimatedShare({ elapsedMs: 60_000, expectedMs: 60_000 }));
        expect(progressShare({ elapsedMs: 60_000 })).toBeUndefined();
    });

    it(`reads elapsed from when it began to when it ended, or to now while it runs`, () => {
        expect(progressAt({ startedAt: 1_000, expectedMs: 5_000 }, 4_000)).toEqual({ elapsedMs: 3_000, expectedMs: 5_000, giveUpMs: undefined, measured: undefined });
        expect(progressAt({ startedAt: 1_000, endedAt: 2_000 }, 9_000).elapsedMs).toBe(1_000);
        expect(progressAt({ startedAt: undefined }, 9_000).elapsedMs).toBeUndefined();
    });

    it(`has given up exactly at its give-up time, and says how long only past a blip`, () => {
        expect(gaveUp({ elapsedMs: 59_999, giveUpMs: 60_000 })).toBe(false);
        expect(gaveUp({ elapsedMs: 60_000, giveUpMs: 60_000 })).toBe(true);
        expect(elapsedWords({ elapsedMs: 4_000 })).toBeUndefined();
        expect(elapsedWords({ elapsedMs: 65_000 })).toBe(`1m 5s`);
    });
});
