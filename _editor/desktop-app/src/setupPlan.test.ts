import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { parseStep, type RunEvent } from "./desktop";
import { LAYER_DONE, advance, parseLayer, progressView, setupPlan, startProgress, tick } from "./setupPlan";

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
            { phase: `first`, label: () => `First`, weight: 100 },
            { phase: `last`, label: () => `Last`, weight: 100 },
        ];
        const measure = (floor: number) => {
            const running = advance(startProgress(plan, 0, floor), line(`intentic: [first] starting`), 0);
            const view = progressView(tick(running, 40_000), 40_000);
            return { percent: view.percent, remaining: view.remaining, remainingMs: view.remainingMs, stepProgress: view.stepProgress };
        };
        // Forty seconds of a 200-second plan leaves 160 seconds, whether its bar began at 0% or at 60%.
        expect([measure(0), measure(60)]).toEqual([
            { percent: 20, remaining: `desktop.setupPlan.aboutMinutes`, remainingMs: 160_000, stepProgress: 0.4 },
            { percent: 68, remaining: `desktop.setupPlan.aboutMinutes`, remainingMs: 160_000, stepProgress: 0.4 },
        ]);
    });
});

it(`weighs a cached sandbox image as reuse, and an absent or unknown one as a download`, () => {
    const weights = [undefined, false, true].map(
        (imageReady) => setupPlan({ dockerReady: true, syncing: true, os: `windows`, imageReady }).find((step) => step.phase === `pulling-image`)?.weight,
    );
    expect(weights).toEqual([240, 240, 2]);
});

/* THE SETUP-PROGRESS RECORD: the phases, weights and pull lines ic's ui.rs, machine_sandbox.rs and the web's agentHouse.ts
are tested against as well, so the three tables of docker's layer states cannot drift apart again. */
// SAFETY: the fixture is this repository's own file, and the assertions below fail on any field it lacks.
const SHARED = JSON.parse(
    readFileSync(join(repoRoot(import.meta.url), `_shared/sandbox-run/src/setup-progress.fixture.json`), `utf8`),
) as {
    phases: string[];
    plans: { input: { os: string; dockerReady: boolean; syncing: boolean; imageReady: boolean }; steps: [string, number][] }[];
    steps: ({ line: string; phase: string; message: string } | { line: string; phase: null })[];
    layerDone: Record<string, number>;
    layers: ({ line: string; id: string; done: number } | { line: string; id: null })[];
};

describe(`the shared setup-progress record`, () => {
    it(`draws every plan it records, phase by phase and weight by weight`, () => {
        for (const { input, steps } of SHARED.plans) {
            expect(setupPlan(input).map((step) => [step.phase, step.weight])).toEqual(steps);
        }
    });

    it(`draws only phases it lists`, () => {
        const drawn = new Set(SHARED.plans.flatMap(({ input }) => setupPlan(input).map((step) => step.phase)));
        expect([...drawn].filter((phase) => !SHARED.phases.includes(phase))).toEqual([]);
    });

    it(`reads a step line as it records`, () => {
        for (const step of SHARED.steps) {
            expect(parseStep(step.line)).toEqual(step.phase === null ? undefined : { phase: step.phase, message: step.message });
        }
    });

    it(`reads a pull line as it records, layer ids in either case`, () => {
        for (const layer of SHARED.layers) {
            expect(parseLayer(layer.line)).toEqual(layer.id === null ? undefined : { id: layer.id, done: layer.done });
        }
        expect(LAYER_DONE).toEqual(SHARED.layerDone);
    });
});
