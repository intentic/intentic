import { estimatedShare, overdue, spanWords, waitWords } from "../waitProgress";

// What a wait says about itself. The promises under test: the bar is an estimate that never claims the wait is over,
// the words stop promising the usual length once it has passed, and the give-up sentence disappears the moment it is
// no longer a promise about the future.

describe(`the estimated bar`, () => {
    it(`starts empty, is about three quarters full at the usual length, and never fills`, () => {
        expect(estimatedShare({ elapsedMs: 0, typicalMs: 60_000 })).toBe(0);
        const atUsual = estimatedShare({ elapsedMs: 60_000, typicalMs: 60_000 }) ?? 0;
        expect(atUsual).toBeGreaterThan(0.7);
        expect(atUsual).toBeLessThan(0.8);
        expect(estimatedShare({ elapsedMs: 60 * 60_000, typicalMs: 60_000 })).toBeLessThan(1);
    });

    it(`only moves forward`, () => {
        const shares = [0, 5_000, 20_000, 60_000, 300_000].map((elapsedMs) => estimatedShare({ elapsedMs, typicalMs: 30_000 }) ?? 0);
        expect(shares).toEqual(shares.toSorted((a, b) => a - b));
    });

    it(`is not drawn without a usual length to draw it from`, () => {
        expect(estimatedShare({ elapsedMs: 10_000 })).toBeUndefined();
        expect(estimatedShare({ elapsedMs: 10_000, typicalMs: 0 })).toBeUndefined();
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
        expect(waitWords({ elapsedMs: 12_000, typicalMs: 60_000, giveUpMs: 3 * 60_000 })).toEqual({
            elapsed: `12s so far`,
            usual: `usually about 1 minute`,
            giveUp: `If it takes more than 3 minutes, we'll show you what you can do.`,
        });
    });

    it(`stop promising the usual length once it has passed`, () => {
        expect(overdue({ elapsedMs: 70_000, typicalMs: 60_000 })).toBe(true);
        expect(waitWords({ elapsedMs: 70_000, typicalMs: 60_000 }).usual).toBe(`longer than the usual 1 minute`);
    });

    it(`drop the give-up sentence once it is no longer about the future`, () => {
        expect(waitWords({ elapsedMs: 3 * 60_000, typicalMs: 60_000, giveUpMs: 3 * 60_000 }).giveUp).toBeUndefined();
    });

    it(`say only how long it has run where nothing can say how long it lasts`, () => {
        expect(waitWords({ elapsedMs: 125_000 })).toEqual({ elapsed: `2m 5s so far`, usual: undefined, giveUp: undefined });
    });
});
