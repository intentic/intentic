import "@intentic/testing/dom";
import { keepRebuild, pastRebuild, timedSteps } from "./rebuildHistory";

// The last rebuild's own lengths are what the next card says "how long is left" from. Pinned: only a run this browser
// watched from its start teaches anything, the owner's hold at the gate is not counted as build time, and a card with
// no past run promises nothing.

beforeEach(() => {
    localStorage.clear();
});

const MINUTE = 60_000;

it(`keeps each step's length from a run it watched begin, leaving the gate's hold out of the image step`, () => {
    const start = 1_000_000;
    keepRebuild(`box`, {
        startedAt: start,
        endedAt: start + 9 * MINUTE,
        stageAt: { compile: start, image: start + MINUTE, swap: start + 8 * MINUTE },
        waitedMs: 3 * MINUTE,
        tasks: 48,
    });

    expect(pastRebuild(`box`)).toEqual({ ms: { compile: MINUTE, image: 4 * MINUTE, swap: MINUTE }, tasks: 48, at: start + 9 * MINUTE });
});

it(`learns nothing from a run adopted mid-flight, whose steps were dated whenever it happened to look`, () => {
    const kept = keepRebuild(`box`, { startedAt: undefined, endedAt: 5, stageAt: { compile: 1, image: 2, swap: 3 }, waitedMs: 0, tasks: undefined });

    expect(kept).toBeUndefined();
    expect(pastRebuild(`box`)).toBeUndefined();
});

it(`sizes the steps by the last run, and says how long each took`, () => {
    const steps = timedSteps({ ms: { compile: MINUTE, image: 3 * MINUTE, swap: 0 }, tasks: undefined, at: 0 });

    expect(steps.map((step) => step.expectedMs)).toEqual([MINUTE, 3 * MINUTE, 0]);
    expect(steps[0]?.weight).toBeCloseTo(0.25, 5);
    // A step too short to draw keeps a sliver, so a running one still has somewhere to fill.
    expect(steps[2]?.weight).toBeGreaterThan(0);
});

it(`promises no lengths before any run was watched`, () => {
    expect(timedSteps(undefined).every((step) => step.expectedMs === undefined)).toBe(true);
});

it(`reads a record some other version wrote, or someone typed, as no record`, () => {
    localStorage.setItem(`intentic.devRebuild.box.took`, `{"ms":{"compile":"soon"}}`);

    expect(pastRebuild(`box`)).toBeUndefined();
});
