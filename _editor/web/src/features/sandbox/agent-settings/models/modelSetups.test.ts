import { MODEL_ROLE_IDS, type ModelPin, type ModelSource, rolePins, type SetupSettings } from "@intentic/sandbox-contract";
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

const FRESH: SetupSettings = { modelSetups: [], roleSetups: {} };
const name = (n: number): string => `Setup ${n}`;

const applied = (settings: SetupSettings, write: SetupsWrite | undefined): SetupSettings => ({ ...settings, ...write });
const resolved = (settings: SetupSettings): Record<string, readonly ModelPin[]> =>
    Object.fromEntries(MODEL_ROLE_IDS.map((role) => [role, rolePins(settings, role, [CLAUDE])]));

test(`a fresh sandbox is three suggested setups, and every job on none until it is placed`, () => {
    const { setups, unassigned } = setupsView(FRESH, [CLAUDE]);

    expect(setups.map((setup) => [setup.id, setup.derived, setup.pins.map((pin) => pin.model), setup.roles])).toEqual([
        [`low`, true, [`claude-haiku-4-5-20251001`], []],
        [`medium`, true, [`claude-sonnet-5`], []],
        [`high`, true, [`claude-opus-5`], []],
    ]);
    expect(unassigned).toEqual(MODEL_ROLE_IDS);
    expect(Object.values(resolved(FRESH)).every((pins) => pins.length === 0)).toBe(true);
});

test(`placing every job on its suggested setup is one write, and each then runs that preset`, () => {
    const after = applied(FRESH, withSuggestedPlaces(FRESH, MODEL_ROLE_IDS));
    const { setups, unassigned } = setupsView(after, [CLAUDE]);

    expect(unassigned).toEqual([]);
    expect(setups.find((setup) => setup.id === `high`)?.roles).toContain(`pipeline-fix`);
    expect(setups.find((setup) => setup.id === `low`)?.roles).toContain(`commit-message`);
    expect(rolePins(after, `pipeline-fix`, [CLAUDE])).toEqual([{ provider: `claude`, model: `claude-opus-5` }]);
});

test(`editing a suggested setup writes it, and its jobs then run what was written`, () => {
    const placed = applied(FRESH, withSuggestedPlaces(FRESH, MODEL_ROLE_IDS));
    const after = applied(placed, withSetupPins(placed, `low`, [opus]));

    expect(after.modelSetups).toEqual([{ id: `low`, pins: [opus] }]);
    expect(setupsView(after, [CLAUDE]).setups[0]?.derived).toBe(false);
    expect(rolePins(after, `commit-message`, [CLAUDE])).toEqual([opus]);
    expect(rolePins(after, `pipeline-fix`, [CLAUDE])).toEqual([{ provider: `claude`, model: `claude-opus-5` }]);
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
    const placed = applied(FRESH, withSuggestedPlaces(FRESH, MODEL_ROLE_IDS));
    const moved = applied(placed, withJobOn(placed, `commit-message`, `high`));
    const before = resolved(placed);
    const after = resolved(moved);

    expect(after[`commit-message`]).toEqual(before[`pipeline-fix`]);
    expect(Object.keys(after).filter((role) => JSON.stringify(after[role]) !== JSON.stringify(before[role]))).toEqual([`commit-message`]);

    const off = applied(moved, withJobOn(moved, `commit-message`, undefined));
    expect(off.roleSetups[`commit-message`]).toBeUndefined();
    expect(setupsView(off, [CLAUDE]).unassigned).toEqual([`commit-message`]);
});

test(`a new setup takes the lowest free number, and a job given one keeps running what it did`, () => {
    const first = withNewSetup(FRESH, name, []);
    expect([first.id, first.write.modelSetups]).toEqual([`setup-1`, [{ id: `setup-1`, name: `Setup 1`, pins: [] }]]);

    const withOne = applied(FRESH, first.write);
    const placed = applied(withOne, withJobOn(withOne, `loop-iteration`, `high`));
    const given = applied(placed, withJobOnNewSetup(placed, `loop-iteration`, name, rolePins(placed, `loop-iteration`, [CLAUDE])));
    expect(given.roleSetups).toEqual({ "loop-iteration": `setup-2` });
    expect(resolved(given)).toEqual(resolved(placed));
});

test(`deleting a setup leaves its jobs on none, listed as such, and every other job where it was`, () => {
    const settings = { modelSetups: [{ id: `setup-1`, name: `Reviews`, pins: [opus] }], roleSetups: { "commit-message": `setup-1`, "pipeline-fix": `high` } };

    const after = applied(settings, withoutSetup(settings, `setup-1`));

    expect(after.modelSetups).toEqual([]);
    expect(after.roleSetups).toEqual({ "pipeline-fix": `high` });
    expect(setupsView(after, [CLAUDE]).unassigned).toContain(`commit-message`);
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

    expect(setupsView(settings, []).setups.map((setup) => setup.id)).toEqual([`low`, `medium`, `high`, `setup-2`, `setup-1`]);
});
