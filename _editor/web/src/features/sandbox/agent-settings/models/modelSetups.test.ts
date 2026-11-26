import { coreModelRoleEntries, type ModelRoleEntry } from "@intentic/sandbox-contract/models/model-roles";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelSource } from "@intentic/sandbox-contract/models/model-pins";
import { rolePins, type SetupSettings } from "@intentic/sandbox-contract/models/model-setups";
import {
    setupsView,
    type SetupsWrite,
    withJobOn,
    withJobOnNewSetup,
    withNewSetup,
    withoutSetup,
    withSetupName,
    withSetupPins,
    withSuggestedModels,
    withSuggestedPlaces,
} from "./modelSetups";

// The page's presses as writes, judged by what each makes every job run on (the contract's own resolver): a press may
// change the jobs it names and no other.

const opus: ModelPin = { provider: `claude`, model: `claude-opus-5`, effort: `high` };
const haiku: ModelPin = { provider: `claude`, model: `claude-haiku-4-5-20251001` };
const CLAUDE: ModelSource = { provider: `claude`, ready: true, models: [`claude-haiku-4-5-20251001`, `claude-opus-5`, `claude-sonnet-5`] };

// The jobs as a daemon serves them: the sandbox's own, Pipelines' fix, and a job of an extension switched off.
const PIPELINE_FIX: ModelRoleEntry = {
    id: `pipeline-fix`,
    label: `Pipeline fixes`,
    blurb: `The agent started by Fix on a failed pipeline.`,
    kind: `run`,
    icon: `wave-pulse`,
    setup: `high`,
    extension: `intentic.pipelines`,
    enabled: true,
};
const OFF_JOB: ModelRoleEntry = { ...PIPELINE_FIX, id: `nightly-audit`, label: `Nightly audits`, setup: `medium`, extension: `acme.audit`, enabled: false };
const JOBS: readonly ModelRoleEntry[] = [...coreModelRoleEntries(), PIPELINE_FIX];
const KNOWN: readonly ModelRoleEntry[] = [...JOBS, OFF_JOB];
const JOB_IDS = JOBS.map((job) => job.id);

const FRESH: SetupSettings = { modelSetups: [], roleSetups: {} };
const name = (n: number): string => `Setup ${n}`;

const applied = (settings: SetupSettings, write: SetupsWrite | undefined): SetupSettings => ({ ...settings, ...write });
const resolved = (settings: SetupSettings): Record<string, readonly ModelPin[]> =>
    Object.fromEntries(JOBS.map((job) => [job.id, rolePins(settings, job.id, [CLAUDE], job.setup)]));

test(`an explicitly empty assignment map leaves every job on none`, () => {
    const { setups, unassigned } = setupsView(FRESH, [CLAUDE], JOBS);

    expect(setups.map((setup) => [setup.id, setup.derived, setup.pins.map((pin) => pin.model), setup.roles])).toEqual([
        [`low`, true, [`claude-haiku-4-5-20251001`], []],
        [`medium`, true, [`claude-sonnet-5`], []],
        [`high`, true, [`claude-opus-5`], []],
    ]);
    expect(unassigned).toEqual(JOB_IDS);
    expect(Object.values(resolved(FRESH)).every((pins) => pins.length === 0)).toBe(true);
});

test(`placing every job on its suggested setup is one write, and each then runs that preset`, () => {
    const after = applied(FRESH, withSuggestedPlaces(FRESH, KNOWN, JOBS));
    const { setups, unassigned } = setupsView(after, [CLAUDE], JOBS);

    expect(unassigned).toEqual([]);
    expect(setups.find((setup) => setup.id === `high`)?.roles).toContain(`pipeline-fix`);
    expect(setups.find((setup) => setup.id === `low`)?.roles).toContain(`commit-message`);
    expect(rolePins(after, `pipeline-fix`, [CLAUDE], `high`)).toEqual([{ provider: `claude`, model: `claude-opus-5` }]);
});

test(`editing a suggested setup writes it, and its jobs then run what was written`, () => {
    const placed = applied(FRESH, withSuggestedPlaces(FRESH, KNOWN, JOBS));
    const after = applied(placed, withSetupPins(placed, `low`, [opus]));

    expect(after.modelSetups).toEqual([{ id: `low`, pins: [opus] }]);
    expect(setupsView(after, [CLAUDE], JOBS).setups[0]?.derived).toBe(false);
    expect(rolePins(after, `commit-message`, [CLAUDE])).toEqual([opus]);
    expect(rolePins(after, `pipeline-fix`, [CLAUDE], `high`)).toEqual([{ provider: `claude`, model: `claude-opus-5` }]);
});

test(`going back to suggested models drops the written list and keeps the name`, () => {
    const settings = { modelSetups: [{ id: `low`, name: `Cheap`, pins: [opus] }], roleSetups: {} };

    expect(withSuggestedModels(settings, `low`).modelSetups).toEqual([{ id: `low`, name: `Cheap` }]);
    expect(withSuggestedModels({ modelSetups: [{ id: `low`, pins: [opus] }], roleSetups: {} }, `low`).modelSetups).toEqual([]);
});

test(`a preset renamed to nothing takes its own name again; a setup of the owner's will not go nameless`, () => {
    const named = applied(FRESH, withSetupName(FRESH, `high`, `  Heavy  `));
    expect(named.modelSetups).toEqual([{ id: `high`, name: `Heavy` }]);
    expect(withSetupName(named, `high`, ``)?.modelSetups).toEqual([]);

    const own = { modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [] }], roleSetups: {} };
    expect(withSetupName(own, `setup-1`, `   `)).toBeUndefined();
});

test(`moving a job changes that job alone, and taking it off leaves no entry`, () => {
    const placed = applied(FRESH, withSuggestedPlaces(FRESH, KNOWN, JOBS));
    const moved = applied(placed, withJobOn(placed, KNOWN, `commit-message`, `high`));
    const before = resolved(placed);
    const after = resolved(moved);

    expect(after[`commit-message`]).toEqual(before[`pipeline-fix`]);
    expect(Object.keys(after).filter((role) => JSON.stringify(after[role]) !== JSON.stringify(before[role]))).toEqual([`commit-message`]);

    const off = applied(moved, withJobOn(moved, KNOWN, `commit-message`, undefined));
    expect(off.roleSetups?.[`commit-message`]).toBeUndefined();
    expect(setupsView(off, [CLAUDE], JOBS).unassigned).toEqual([`commit-message`]);
});

test(`a new setup takes the lowest free number, and a job given one keeps running what it did`, () => {
    const first = withNewSetup(FRESH, name, []);
    expect([first.id, first.write.modelSetups]).toEqual([`setup-1`, [{ id: `setup-1`, name: `Setup 1`, pins: [] }]]);

    const withOne = applied(FRESH, first.write);
    const placed = applied(withOne, withJobOn(withOne, KNOWN, `loop-iteration`, `high`));
    const given = applied(placed, withJobOnNewSetup(placed, KNOWN, `loop-iteration`, name, rolePins(placed, `loop-iteration`, [CLAUDE])));
    expect(given.roleSetups).toEqual({ "loop-iteration": `setup-2` });
    expect(resolved(given)).toEqual(resolved(placed));
});

test(`deleting a setup leaves its jobs on none, listed as such, and every other job where it was`, () => {
    const settings = { modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [opus] }], roleSetups: { "commit-message": `setup-1`, "pipeline-fix": `high` } };

    const after = applied(settings, withoutSetup(settings, `setup-1`));

    expect(after.modelSetups).toEqual([]);
    expect(after.roleSetups).toEqual({ "pipeline-fix": `high` });
    expect(setupsView(after, [CLAUDE], JOBS).unassigned).toContain(`commit-message`);
});

test(`the owner's setups follow the presets in the order they were made`, () => {
    const settings = {
        modelSetups: [
            { id: `setup-2`, name: `B`, pins: [] },
            { id: `high`, pins: [opus] },
            { id: `setup-1`, name: `A`, pins: [haiku] },
        ],
        roleSetups: {},
    };

    expect(setupsView(settings, [], JOBS).setups.map((setup) => setup.id)).toEqual([`low`, `medium`, `high`, `setup-2`, `setup-1`]);
});

// (2026-11-26) A sandbox that never placed its jobs stores no map: each job runs on its suggestion, an extension's on its
// declaration's, and the first placement writes the map down whole, switched-off extensions' jobs included.
describe(`a sandbox that never placed its jobs`, () => {
    const NEVER: SetupSettings = { modelSetups: [] };

    test(`shows every job on its suggested setup, an extension's on its declaration's`, () => {
        const { setups, unassigned } = setupsView(NEVER, [CLAUDE], JOBS);
        expect(unassigned).toEqual([]);
        expect(setups.find((setup) => setup.id === `high`)?.roles).toContain(`pipeline-fix`);
        expect(setups.flatMap((setup) => setup.roles)).not.toContain(`nightly-audit`);
        expect(resolved(NEVER)[`pipeline-fix`]).toEqual([{ provider: `claude`, model: `claude-opus-5` }]);
    });

    test(`moving one job writes every known job where it ran, a switched-off extension's too, and moves only that one`, () => {
        const moved = applied(NEVER, withJobOn(NEVER, KNOWN, `commit-message`, `high`));
        expect(moved.roleSetups).toEqual({ ...Object.fromEntries(KNOWN.map((job) => [job.id, job.setup])), "commit-message": `high` });
        const before = resolved(NEVER);
        const after = resolved(moved);
        expect(Object.keys(after).filter((role) => JSON.stringify(after[role]) !== JSON.stringify(before[role]))).toEqual([`commit-message`]);
    });

    test(`deleting a setup of the owner's leaves the map unwritten, since no job was on it`, () => {
        const settings = { modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [opus] }] };
        expect(withoutSetup(settings, `setup-1`)).toEqual({ modelSetups: [] });
    });
});

test(`a choice for a switched-off extension's job is kept through a move, and read again once it is back`, () => {
    const settings: SetupSettings = { modelSetups: [], roleSetups: { "commit-message": `low`, "nightly-audit": `high` } };
    const moved = applied(settings, withJobOn(settings, KNOWN, `commit-message`, `medium`));
    expect(moved.roleSetups).toEqual({ "commit-message": `medium`, "nightly-audit": `high` });
    expect(setupsView(moved, [CLAUDE], JOBS).setups.flatMap((setup) => setup.roles)).not.toContain(`nightly-audit`);
    const back = setupsView(moved, [CLAUDE], [...JOBS, { ...OFF_JOB, enabled: true }]);
    expect(back.setups.find((setup) => setup.id === `high`)?.roles).toContain(`nightly-audit`);
});
