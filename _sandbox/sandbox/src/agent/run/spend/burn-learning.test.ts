import { averaged, MIN_POINTS, stepAnchor } from "./burn-learning.js";

/* radarsu's five-hour window went from 16% to 100% between 15:37 and 16:39 on 2026-10-20 under about 92M meter units:
   1.10M a point. What a projection reads is that ratio, learned an interval at a time. */

const RESET = 1_792_522_800;
const at = (minute: number): number => Date.parse("2026-10-20T15:37:00Z") + minute * 60_000;

describe("learning what one point of a window costs", () => {
    it("holds its anchor until the window moved far enough for whole percents to mean something", () => {
        const first = stepAnchor(undefined, { utilization: 16, resetsAt: RESET, at: at(0) }, () => 1);
        const small = stepAnchor(first.anchor, { utilization: 16 + MIN_POINTS - 1, resetsAt: RESET, at: at(5) }, () => 3_000_000);
        expect(small).toEqual({ anchor: first.anchor });
        const closed = stepAnchor(small.anchor, { utilization: 100, resetsAt: RESET, at: at(62) }, (from, to) => (from === at(0) && to === at(62) ? 92_400_000 : 0));
        expect(closed.tokensPerPoint).toBeCloseTo(1_100_000);
        expect(closed.anchor).toEqual({ utilization: 100, resetsAt: RESET, at: at(62) });
    });

    it("re-anchors at a reset, a window that fell back, and an interval nothing was metered over", () => {
        const anchor = { utilization: 40, resetsAt: RESET, at: at(0) };
        expect(stepAnchor(anchor, { utilization: 60, resetsAt: RESET + 5 * 3_600, at: at(10) }, () => 9)).toEqual({ anchor: { utilization: 60, resetsAt: RESET + 5 * 3_600, at: at(10) } });
        expect(stepAnchor(anchor, { utilization: 10, resetsAt: RESET, at: at(10) }, () => 9).tokensPerPoint).toBeUndefined();
        // Moved by somebody else entirely, or before the meter's reach: nothing to learn from.
        expect(stepAnchor(anchor, { utilization: 60, resetsAt: RESET, at: at(10) }, () => 0).tokensPerPoint).toBeUndefined();
        expect(stepAnchor(anchor, { utilization: 60, resetsAt: RESET, at: at(10) }, () => undefined).tokensPerPoint).toBeUndefined();
    });

    it("averages samples, and past a few clamps one far off the figure it has", () => {
        let average = averaged(undefined, 1_000_000, 1);
        expect(average).toEqual({ value: 1_000_000, samples: 1, at: 1 });
        average = averaged(averaged(average, 1_200_000, 2), 1_100_000, 3);
        const settled = average.value;
        const outlier = averaged(average, 1, 4);
        // Clamped to a third of the figure before it moves it.
        expect(outlier.value).toBeCloseTo(settled * 0.7 + (settled / 3) * 0.3);
    });
});
