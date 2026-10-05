import type { SetupArgs } from "../desktop";
import type { ProgressView, StepView } from "../setupPlan";
import { type BuildFacts, projectBuildOf, projectPathOf } from "./projectBuild";

// A folder's build card reads this window's setup store: what it says while the sandbox goes up, when the folder counts
// as moved in, and where "Open sandbox" goes.

const ADOPTED: SetupArgs = {
    code: `c0de`,
    sandboxId: `cmuudvkwr001b01r822aawr1l`,
    name: `test-remove-me`,
    syncDir: `C:\\Users\\me\\Documents\\test-remove-me`,
    project: `test-remove-me`,
};

const step = (phase: string, state: StepView[`state`]): StepView => ({ phase, label: `Label of ${phase}`, state, detail: undefined, share: 0.1 });

const view = (steps: readonly StepView[], over: Partial<ProgressView> = {}): ProgressView => ({
    steps,
    percent: 42,
    position: undefined,
    remaining: undefined,
    remainingMs: 90_000,
    stepProgress: 0.5,
    ...over,
});

const facts = (over: Partial<BuildFacts> = {}): BuildFacts => ({ adopted: ADOPTED, state: `running`, view: undefined, error: undefined, ...over });

it(`draws nothing for a window that adopted no folder build`, () => {
    expect(projectBuildOf(facts({ adopted: undefined }))).toBeUndefined();
});

it(`builds through the running step, with its own words, its progress and the time left`, () => {
    const running = view([step(`preflight`, `done`), step(`pulling-image`, `running`), step(`starting-sandbox`, `waiting`)]);
    expect(projectBuildOf(facts({ view: running }))).toEqual({
        name: `test-remove-me`,
        state: `building`,
        phase: `pulling-image`,
        phaseProgress: 0.5,
        step: `Label of pulling-image`,
        percent: 42,
        remainingMs: 90_000,
        error: undefined,
    });
});

// The device's own connection is the setup's last step and none of the folder's: the reader may open the sandbox while
// it finishes behind.
it(`is ready once the folder is in, while the device's own connection still runs`, () => {
    const connecting = view([step(`desktop-sync`, `done`), step(`connecting-machine`, `running`)]);
    const build = projectBuildOf(facts({ view: connecting }));
    expect({ state: build?.state, percent: build?.percent, remainingMs: build?.remainingMs }).toEqual({ state: `ready`, percent: 100, remainingMs: undefined });
});

it(`stands as far as it got when it ends, saying why only for a failure`, () => {
    const stopped = view([step(`pulling-image`, `done`), step(`starting-sandbox`, `stopped`), step(`waiting-health`, `stopped`)]);
    const failed = projectBuildOf(facts({ state: `failed`, view: stopped, error: `docker refused` }));
    expect({ state: failed?.state, phase: failed?.phase, error: failed?.error }).toEqual({ state: `failed`, phase: `pulling-image`, error: `docker refused` });
    const asked = projectBuildOf(facts({ state: `waiting`, view: stopped, error: `needs consent` }));
    expect({ state: asked?.state, error: asked?.error }).toEqual({ state: `waiting`, error: undefined });
    expect(projectBuildOf(facts({ state: `stopped`, view: stopped }))?.state).toBe(`stopped`);
    expect(projectBuildOf(facts({ state: `done`, view: stopped }))?.state).toBe(`ready`);
});

it(`opens the built sandbox on the folder, and nowhere without a sandbox to name`, () => {
    expect(projectPathOf(ADOPTED)).toBe(`/?sandbox=cmuudvkwr001b01r822aawr1l&project=test-remove-me`);
    expect(projectPathOf({ sandboxId: `a b`, project: `x&y` })).toBe(`/?sandbox=a+b&project=x%26y`);
    expect(projectPathOf({ sandboxId: undefined, project: `x` })).toBeUndefined();
});
