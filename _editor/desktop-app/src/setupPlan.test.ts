import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { parseStep, type RunEvent } from "./desktop";
import { LAYER_DONE, advance, approach, parseDownload, parseLayer, progressView, setupPlan, startProgress, tick, type Progress } from "./setupPlan";

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

/* THE PULL, AS ITS BYTES COME IN (2026-10-12): a 2.2 GB image fetched by ic's cache, which says how many bytes it has
every two seconds. The bar used to read none of it, and stood at 53% for nineteen minutes while they came. */
const MIB = 1024 * 1024;
const PULL_PLAN = [
    { phase: `claiming-code`, label: () => `Claim`, weight: 5 },
    { phase: `pulling-image`, label: () => `Pull`, weight: 240 },
    { phase: `starting-sandbox`, label: () => `Start`, weight: 25 },
];
const reading = (mb: number, total = 2200): RunEvent => line(`      downloading the sandbox image: ${mb} of ${total} MB (8.0 MB/s)`);
// The pull under way since `at`, the step before it done.
const pulling = (at = 0): Progress =>
    advance(advance(startProgress(PULL_PLAN, 0), line(`intentic: [claiming-code] redeeming`), 0), line(`intentic: [pulling-image] using the image`), at);

describe(`the pull's bytes`, () => {
    it(`are read off ic's line, its megabytes being 1024 × 1024 bytes, and nothing else is`, () => {
        expect(parseDownload(`      downloading the sandbox image: 812 of 2140 MB (11.2 MB/s)`)).toEqual({ done: 812 * MIB, total: 2140 * MIB });
        expect(parseDownload(`downloading the sandbox image: 0 of 2140 MB`)).toEqual({ done: 0, total: 2140 * MIB });
        expect(parseDownload(`downloading the sandbox image: 5 of 0 MB`)).toBeUndefined();
        expect(parseDownload(`intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable`)).toBeUndefined();
        expect(parseDownload(`a1f1879bd7bf: Downloading [====>    ]  12.3MB/45.6MB`)).toBeUndefined();
    });

    it(`move the bar with every reading, even one that comes after the clock had moved it on`, () => {
        // Three minutes of the clock alone, well past where the weight said the pull would be over.
        let state = tick(pulling(1_000), 181_000);
        let previous = state.percent;
        for (let at = 183_000, mb = 100; mb <= 2100; at += 2_000, mb += 100) {
            state = advance(state, reading(mb), at);
            expect(state.percent).toBeGreaterThan(previous);
            previous = state.percent;
        }
        expect(progressView(state, 223_000).download).toEqual({ done: 2100 * MIB, total: 2200 * MIB, bytesPerSecond: 50 * MIB });
    });

    it(`time what is left by the rate measured over the last minute, not by the step's weight`, () => {
        const at = (state: Progress, mbs: readonly number[], every: number): Progress =>
            mbs.reduce((sofar, mb, index) => advance(sofar, reading(mb), index * every), state);
        // 10 MB/s: 1700 MB left is 170 s, then Docker's load, then the one short step after.
        const fast = progressView(at(pulling(), [200, 300, 400, 500], 10_000), 30_000);
        expect(fast.download?.bytesPerSecond).toBe(10 * MIB);
        expect(fast.remainingMs).toBeGreaterThanOrEqual((170 + 60) * 1000 + 25 * 400);
        expect(fast.remainingMs).toBeLessThanOrEqual((170 + 60) * 1000 + 25 * 4000);
        // 2 MB/s: the same position, four times as long, far past anything the 240-second weight could say.
        const slow = progressView(at(pulling(), [200, 220, 240, 260], 10_000), 30_000);
        expect(slow.remainingMs).toBeGreaterThan(((2200 - 260) / 2) * 1000);
    });

    it(`say nothing about the rate until the readings span ten seconds`, () => {
        const state = advance(advance(pulling(), reading(200), 0), reading(220), 4_000);
        expect(progressView(state, 4_000).download?.bytesPerSecond).toBeUndefined();
    });

    it(`hand the step to Docker's load once all in, which creeps on and never reaches the step's end`, () => {
        const done = advance(advance(pulling(), reading(2100), 0), reading(2200), 2_000);
        const loading = (at: number) => progressView(tick(done, at), at);
        expect(loading(2_000).steps[1]?.detail).toBe(`desktop.setupPlan.loadingImage`);
        expect(loading(10_000).stepProgress).toBeGreaterThanOrEqual(0.9);
        expect(loading(600_000).stepProgress).toBeGreaterThan(loading(120_000).stepProgress);
        expect(loading(3_600_000).stepProgress).toBeLessThan(0.98);
    });

    it(`say what is in while it comes, and belong to the pull alone`, () => {
        const state = advance(pulling(), reading(812), 0);
        expect(progressView(state, 0).steps[1]?.detail).toBe(`desktop.setupPlan.downloadedOf`);
        const started = advance(state, line(`intentic: [starting-sandbox] starting`), 1_000);
        expect(progressView(started, 1_000).download).toBeUndefined();
    });

    it(`give way to docker's own layers when the pull takes over from a download that could not be used`, () => {
        const state = advance(advance(pulling(), reading(812), 0), line(`6e3729cf69e0: Pull complete`), 1_000);
        expect(progressView(state, 1_000).download).toBeUndefined();
    });
});

describe(`a step with nothing but the clock to go by`, () => {
    it(`runs straight to the knee, then creeps towards the cap without ever reaching it`, () => {
        expect([approach(0), approach(0.4), approach(0.6)]).toEqual([0, 0.4, 0.6]);
        const later = [1, 2, 4, 8, 60].map((x) => approach(x));
        for (const [index, value] of later.entries()) {
            expect(value).toBeGreaterThan(index === 0 ? 0.6 : (later[index - 1] ?? 0));
            expect(value).toBeLessThan(0.9);
        }
    });

    it(`keeps the bar moving long after the step's weight has run out`, () => {
        // The pull with no bytes and no layers, as a Docker that prints neither would leave it.
        const state = pulling();
        const at = (minutes: number) => tick(state, minutes * 60_000).percent;
        expect(at(20)).toBeGreaterThan(at(10));
        expect(at(40) - at(20)).toBeGreaterThanOrEqual(1);
        expect(at(40)).toBeLessThan(at(0) + (100 * 240 * 0.9) / 270);
    });
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
