// What a runner op's stream says about where it is. The lines are `ic runner up`'s own (runner.rs, with the setup's
// phase markers it shares with `ic sandbox connect`), docker's pull and BuildKit's build, as a machine streams them to
// the Devices page. The English catalog is loaded for tests, so the words are asserted as a reader sees them.
import { stepFill } from "../../../../components/progress/stagedSteps";
import { foldRunnerFlow, type RunnerFlow, type RunnerRun, runnerRunView, settleRunnerFlow, startRunnerFlow } from "./runnerStages";

const fold = (flow: RunnerFlow, lines: readonly string[], at = 0): RunnerFlow =>
    lines.reduce((acc, line, index) => foldRunnerFlow(acc, line, at + index * 1_000), flow);

const runOf = (flow: RunnerFlow): RunnerRun => {
    if (flow.op === `update`) {
        throw new Error(`an update is read by deviceUpdateStages.ts`);
    }
    return flow.run;
};

const UP = [
    `intentic: starting runner omen…`,
    `intentic: [pulling-image] pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)…`,
    `stable: Pulling from intentic/sandbox`,
    `aaaaaaaaaaaa: Already exists`,
    `bbbbbbbbbbbb: Pulling fs layer`,
    `bbbbbbbbbbbb: Pull complete`,
];
const BUILD = [
    `intentic: [building-environment] building intentic-sandbox-env-runner-omen:0123456789ab from the parent's approved overlay…`,
    `#6 2.181 info: profile set to minimal`,
    `#6 2.852 info: downloading 6 components`,
];
const BOOT = [`intentic: [starting-sandbox] starting runner omen…`, `intentic: [waiting-health] waiting for the runner daemon to come up…`];

describe(`a runner being added`, () => {
    it(`starts on its download, timed from the press, with no build promised`, () => {
        const run = runOf(startRunnerFlow(`create`, `omen`, 1_000));
        const view = runnerRunView(run, 1_000);
        expect(view.steps.map((step) => step.label)).toEqual([`Downloading the sandbox image`, `Starting the runner`, `Waiting for it to answer`]);
        expect(view.stage).toBe(`pulling-image`);
        expect(view.status).toBe(`running`);
        expect(run.stageAt).toEqual({ "pulling-image": 1_000 });
    });

    it(`moves step by step on ic's markers, timing each from its own marker`, () => {
        const run = runOf(fold(startRunnerFlow(`create`, `omen`, 0), [...UP, ...BOOT]));
        const view = runnerRunView(run, 8_000);
        expect(view.stage).toBe(`waiting-health`);
        expect(run.stageAt).toEqual({ "pulling-image": 0, "starting-sandbox": 6_000, "waiting-health": 7_000 });
        // ic's own sentence about the step it is on, without its prefix or its phase id.
        expect(view.detail).toBe(`waiting for the runner daemon to come up…`);
    });

    it(`draws the environment build after the download only once ic announces one`, () => {
        const run = runOf(fold(startRunnerFlow(`create`, `omen`, 0), [...UP, ...BUILD]));
        const view = runnerRunView(run, 9_000);
        expect(view.steps.map((step) => step.key)).toEqual([`pulling-image`, `building-environment`, `starting-sandbox`, `waiting-health`]);
        expect(view.stage).toBe(`building-environment`);
        // BuildKit's lines are the log's, not the card's: the step says what ic said it is building.
        expect(view.detail).toMatch(/^building intentic-sandbox-env-runner-omen/u);
    });

    it(`opens a build announced late empty, the download behind it whole, and moves on from there`, () => {
        const built = fold(startRunnerFlow(`create`, `omen`, 0), [...UP, BUILD[0]!]);
        const view = runnerRunView(runOf(built), UP.length * 1_000);
        // The same work in a longer plan: where the download ends is where the build's own segment begins.
        expect(stepFill(view.steps, `pulling-image`, view.measured)).toBeCloseTo(1, 5);
        expect(stepFill(view.steps, `building-environment`, view.measured)).toBeLessThan(0.05);

        let flow = built;
        let last = view.measured;
        for (const [index, line] of [...BUILD.slice(1), ...BOOT].entries()) {
            const at = (UP.length + 1 + index) * 1_000;
            flow = foldRunnerFlow(flow, line, at);
            const measured = runnerRunView(runOf(flow), at).measured;
            expect(measured).toBeGreaterThanOrEqual(last);
            last = measured;
        }
    });

    it(`ends with every step done, whichever markers an older ic left unsaid`, () => {
        const flow = settleRunnerFlow(fold(startRunnerFlow(`create`, `omen`, 0), UP), `ok`, 30_000);
        const view = runnerRunView(runOf(flow), 30_000);
        expect(view.status).toBe(`done`);
        expect(view.stage).toBe(`waiting-health`);
        expect(view.measured).toBe(1);
        expect(runOf(flow).endedAt).toBe(30_000);
    });

    it(`stops on the step it failed in, and reads a dropped stream as unheard rather than failed`, () => {
        const failed = runnerRunView(runOf(settleRunnerFlow(fold(startRunnerFlow(`create`, `omen`, 0), [...UP, ...BUILD]), `failed`, 9_000)), 9_000);
        expect(failed).toMatchObject({ status: `stopped`, stage: `building-environment` });
        const lost = runnerRunView(runOf(settleRunnerFlow(fold(startRunnerFlow(`create`, `omen`, 0), UP), `lost`, 9_000)), 9_000);
        expect(lost.status).toBe(`unheard`);
    });
});

describe(`a runner being removed`, () => {
    it(`is one step, said in ic's own words`, () => {
        const run = runOf(fold(startRunnerFlow(`remove`, `omen`, 0), [`intentic: Removing runner-omen…`]));
        const view = runnerRunView(run, 1_000);
        expect(view.steps.map((step) => step.label)).toEqual([`Removing its container`]);
        expect(view.detail).toBe(`Removing runner-omen…`);
        expect(runnerRunView(runOf(settleRunnerFlow({ op: `remove`, name: `omen`, run }, `ok`, 2_000)), 2_000).status).toBe(`done`);
    });
});

describe(`a runner being updated`, () => {
    it(`is read as the sandbox update it is`, () => {
        const flow = fold(startRunnerFlow(`update`, `omen`, 0), [
            `intentic: pulling ghcr.io/intentic/sandbox:stable…`,
            `intentic: recreating the sandbox from ghcr.io/intentic/sandbox:stable…`,
        ]);
        expect(flow.op).toBe(`update`);
        expect(flow.op === `update` ? flow.run.stage : undefined).toBe(`swap`);
        const lost = settleRunnerFlow(flow, `lost`, 5_000);
        expect(lost.op === `update` ? lost.run.phase : undefined).toBe(`severed`);
        const failed = settleRunnerFlow(flow, `failed`, 5_000);
        expect(failed.op === `update` ? failed.run.phase : undefined).toBe(`failed`);
    });
});
