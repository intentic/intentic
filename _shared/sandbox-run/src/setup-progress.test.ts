import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    LAYER_DONE,
    advance,
    approach,
    downloadOf,
    parseDownload,
    parseLayer,
    parseStep,
    type Progress,
    type ProgressEvent,
    remainingMsOf,
    setupSteps,
    startProgress,
    stepFraction,
    stepStateOf,
    tick,
} from "./setup-progress.js";

const line = (text: string): ProgressEvent => ({ kind: `line`, text });
const MIB = 1024 * 1024;

/* THE SETUP-PROGRESS RECORD: the phases, weights and pull lines ic's ui.rs, the desktop app's setup_progress.rs and the
web's agentHouse.ts are tested against as well, so the tables cannot drift apart again. */
// SAFETY: the fixture is this package's own file, and the assertions below fail on any field it lacks.
const SHARED = JSON.parse(readFileSync(join(import.meta.dirname, `setup-progress.fixture.json`), `utf8`)) as {
    phases: string[];
    plans: { input: { os: string; dockerReady: boolean; syncing: boolean; imageReady: boolean }; steps: [string, number][] }[];
    steps: ({ line: string; phase: string; message: string } | { line: string; phase: null })[];
    layerDone: Record<string, number>;
    layers: ({ line: string; id: string; done: number } | { line: string; id: null })[];
};

describe(`the shared setup-progress record`, () => {
    it(`draws every plan it records, phase by phase and weight by weight`, () => {
        for (const { input, steps } of SHARED.plans) {
            expect(setupSteps(input).map((step) => [step.phase, step.weight])).toEqual(steps);
        }
    });

    it(`draws only phases it lists`, () => {
        const drawn = new Set(SHARED.plans.flatMap(({ input }) => setupSteps(input).map((step) => step.phase)));
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
        expect(SHARED.layerDone).toEqual(LAYER_DONE);
    });
});

it(`weighs a cached sandbox image as reuse, and an absent or unknown one as a download`, () => {
    const weights = [undefined, false, true].map(
        (imageReady) => setupSteps({ dockerReady: true, syncing: true, os: `windows`, imageReady }).find((step) => step.phase === `pulling-image`)?.weight,
    );
    expect(weights).toEqual([240, 240, 2]);
});

/* A CONNECTED MACHINE'S RUN, as the web's "Set it up on <machine>" press hears it (2026-10-21): the lines a Windows PC
on the Intentic engine printed, credential-helper noise and key-file paths included. */
describe(`a run read line by line`, () => {
    const plan = setupSteps({ dockerReady: true, syncing: false, os: `linux` });
    const RUN = [
        `intentic: [preflight] checking this device…`,
        `intentic: [claiming-code] redeeming the setup code…`,
        `intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…`,
        `error getting credentials - err: exec: "docker-credential-desktop.exe": executable file not found in $PATH, out: \`\``,
        `intentic: pull failed but the image exists locally — using the local copy.`,
        `intentic: [starting-sandbox] starting sandbox…`,
        `intentic: The credentials sandbox-bedc615644c3 stores are encrypted at rest from now on, with a key made for it.`,
        `intentic: [waiting-health] waiting for the sandbox daemon to come up…`,
    ];
    const folded = RUN.reduce((state, text, at) => advance(state, line(text), at * 1_000), startProgress(plan, 0));

    it(`stands on the last phase it heard, in that phase's own words, and ignores everything else`, () => {
        expect(plan[folded.index]?.phase).toBe(`waiting-health`);
        expect(folded.detail).toBe(`waiting for the sandbox daemon to come up…`);
        expect(stepStateOf(folded, folded.index)).toBe(`running`);
        expect(stepStateOf(folded, folded.index - 1)).toBe(`done`);
        expect(stepStateOf(folded, folded.index + 1)).toBe(`waiting`);
    });

    it(`ends at 100 when the run does, and keeps where it stood when it fails`, () => {
        expect(advance(folded, { kind: `exit`, ok: true }, 9_000).percent).toBe(100);
        const failed = advance(folded, { kind: `exit`, ok: false }, 9_000);
        expect(failed.percent).toBe(folded.percent);
        expect(stepStateOf(failed, failed.index)).toBe(`stopped`);
        expect(remainingMsOf(failed, 9_000)).toBeUndefined();
    });

    it(`never goes back for a phase it already passed`, () => {
        const again = advance(folded, line(`intentic: [preflight] checking again`), 9_000);
        expect(again.index).toBe(folded.index);
    });
});

describe(`the pull's bytes`, () => {
    const PULL_PLAN = [
        { phase: `claiming-code`, weight: 5 },
        { phase: `pulling-image`, weight: 240 },
        { phase: `starting-sandbox`, weight: 25 },
    ];
    const reading = (mb: number, total = 2200): ProgressEvent => line(`      downloading the sandbox image: ${mb} of ${total} MB (8.0 MB/s)`);
    const pulling = (at = 0): Progress =>
        advance(advance(startProgress(PULL_PLAN, 0), line(`intentic: [claiming-code] redeeming`), 0), line(`intentic: [pulling-image] using the image`), at);

    it(`are read off ic's line, its megabytes being 1024 × 1024 bytes, and nothing else is`, () => {
        expect(parseDownload(`      downloading the sandbox image: 812 of 2140 MB (11.2 MB/s)`)).toEqual({ done: 812 * MIB, total: 2140 * MIB });
        expect(parseDownload(`downloading the sandbox image: 5 of 0 MB`)).toBeUndefined();
        expect(parseDownload(`a1f1879bd7bf: Downloading [====>    ]  12.3MB/45.6MB`)).toBeUndefined();
    });

    it(`move the bar with every reading, and report the rate once they span ten seconds`, () => {
        let state = tick(pulling(1_000), 181_000);
        let previous = state.percent;
        for (let at = 183_000, mb = 100; mb <= 2100; at += 2_000, mb += 100) {
            state = advance(state, reading(mb), at);
            expect(state.percent).toBeGreaterThan(previous);
            previous = state.percent;
        }
        expect(downloadOf(state)).toEqual({ done: 2100 * MIB, total: 2200 * MIB, bytesPerSecond: 50 * MIB });
        expect(stepFraction(state, 223_000)).toBeLessThan(0.9);
    });
});

it(`keeps a clock-only step creeping towards its cap without reaching it`, () => {
    expect([approach(0), approach(0.4), approach(0.6)]).toEqual([0, 0.4, 0.6]);
    const later = [1, 2, 4, 8, 60].map((x) => approach(x));
    for (const [index, value] of later.entries()) {
        expect(value).toBeGreaterThan(index === 0 ? 0.6 : (later[index - 1] ?? 0));
        expect(value).toBeLessThan(0.9);
    }
});
