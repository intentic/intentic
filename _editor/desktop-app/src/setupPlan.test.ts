import type { RunEvent } from "./desktop";
import { advance, progressView, setupPlan, startProgress, tick } from "./setupPlan";

// No catalog is registered here, so a step's label reads back as its key; only the numbers are asserted.
const PLAN = setupPlan({ dockerReady: false, syncing: false, os: `windows` });
const line = (text: string): RunEvent => ({ kind: `line`, run: `setup`, stream: `stdout`, text });

describe(`a re-run's bar`, () => {
    it(`starts from nothing on a setup's first attempt`, () => {
        expect(progressView(startProgress(PLAN, 0), 0).percent).toBe(0);
    });

    it(`starts where the last attempt left it, and only rises from there`, () => {
        const first = advance(startProgress(PLAN, 0, 10), line(`intentic: [fetching-ic] fetching`), 0);
        expect(progressView(startProgress(PLAN, 0, 10), 0).percent).toBe(10);
        // The same step that sat at the very start of the first attempt's bar is now drawn from 10%, not from 0%.
        expect(first.percent).toBeGreaterThanOrEqual(10);
        const later = tick(advance(first, line(`intentic: [installing-docker] installing`), 1_000), 60_000);
        expect(later.percent).toBeGreaterThan(first.percent);
        expect(later.percent).toBeLessThan(100);
    });

    it(`estimates only the work this attempt has left`, () => {
        const fresh = advance(startProgress(PLAN, 0), line(`intentic: [preflight] checking`), 0);
        const carried = advance(startProgress(PLAN, 0, 40), line(`intentic: [preflight] checking`), 0);
        // The same position in the plan, the same estimate: a floor moves the bar, not the clock.
        expect(progressView(carried, 0).remaining).toBe(progressView(fresh, 0).remaining);
    });

    it(`carries the bar without shortening the card's millisecond estimate or changing phase progress`, () => {
        const plan = [
            { phase: `first`, label: `First`, weight: 100 },
            { phase: `last`, label: `Last`, weight: 100 },
        ];
        const measure = (floor: number) => {
            const running = advance(startProgress(plan, 0, floor), line(`intentic: [first] starting`), 0);
            const view = progressView(tick(running, 40_000), 40_000);
            return { percent: view.percent, remaining: view.remaining, remainingMs: view.remainingMs, stepProgress: view.stepProgress };
        };
        // Forty seconds of a 200-second plan leaves 160 seconds, whether its bar began at 0% or at 60%.
        expect([measure(0), measure(60)]).toEqual([
            { percent: 20, remaining: `about 3 minutes`, remainingMs: 160_000, stepProgress: 0.4 },
            { percent: 68, remaining: `about 3 minutes`, remainingMs: 160_000, stepProgress: 0.4 },
        ]);
    });
});

it(`weighs a cached sandbox image as reuse, and an absent or unknown one as a download`, () => {
    const weights = [undefined, false, true].map(
        (imageReady) => setupPlan({ dockerReady: true, syncing: true, os: `windows`, imageReady }).find((step) => step.phase === `pulling-image`)?.weight,
    );
    expect(weights).toEqual([240, 240, 2]);
});
