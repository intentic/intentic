import { MODEL_ROLE_IDS, type ModelPin, type ModelRole, rolePins, type RolePinSettings } from "@intentic/sandbox-contract";
import { DEFAULT_PATH, editPath, followDefault, type Layout, makeDefault, type ModelPath, modelPaths, moveJob, type PathWrite } from "./modelPaths";

// The page's blocks are read off per-job settings, so these pin the two promises that reading makes: jobs sharing a
// list are one block, and no press changes what a job runs on except the one that says so.

const opus: ModelPin = { provider: `claude`, model: `claude-opus-5-5`, effort: `high` };
const sol: ModelPin = { provider: `codex`, model: `gpt-6.1-sol` };
const haiku: ModelPin = { provider: `claude`, model: `claude-haiku-5-5`, effort: `low` };

const NONE: Layout = new Map();

// Every job's list as the daemon would resolve it: what no write here may change unless it means to.
const resolved = (settings: RolePinSettings): Record<string, readonly ModelPin[]> =>
    Object.fromEntries(MODEL_ROLE_IDS.map((role) => [role, rolePins(settings, role)]));

const applied = (settings: RolePinSettings, write: PathWrite): RolePinSettings => ({ ...settings, ...write.fields });

const own = (paths: readonly ModelPath[]): readonly (readonly ModelRole[])[] => paths.filter((path) => !path.isDefault).map((path) => path.roles);

let minted = 0;
const mint = (): string => `n:${++minted}`;

test(`a fresh sandbox is one block: every job on the default, whatever it holds`, () => {
    const [only, ...rest] = modelPaths({ modelRoles: {}, modelDefault: [] }, NONE);

    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: DEFAULT_PATH, isDefault: true, pins: [] });
    expect(only!.roles).toEqual(MODEL_ROLE_IDS);
});

test(`jobs holding the same list are one block, whatever category they were once filed under`, () => {
    const settings = {
        modelDefault: [],
        modelRoles: { "commit-message": [haiku], "pipeline-fix": [opus, sol], "loop-iteration": [opus, sol], "session-title": [haiku] },
    };

    expect(own(modelPaths(settings, NONE))).toEqual([
        [`commit-message`, `session-title`],
        [`pipeline-fix`, `loop-iteration`],
    ]);
});

test(`a knob the provider ignores does not split two jobs into two blocks`, () => {
    const settings = {
        modelDefault: [],
        modelRoles: { "pipeline-fix": [sol], "deployment-fix": [{ ...sol, thinking: true }] },
    };

    expect(own(modelPaths(settings, NONE))).toEqual([[`pipeline-fix`, `deployment-fix`]]);
});

test(`editing a block writes every job in it, and only them`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "pipeline-fix": [opus], "refactor-run": [opus], "acceptance-run": [sol] } };
    const paths = modelPaths(settings, NONE);
    const block = paths.find((path) => path.roles.includes(`pipeline-fix`))!;

    const write = editPath(settings, NONE, block, [sol, opus]);
    const after = applied(settings, write);

    expect(after.modelRoles).toEqual({ "pipeline-fix": [sol, opus], "refactor-run": [sol, opus], "acceptance-run": [sol] });
    expect(after.modelDefault).toEqual([haiku]);
    // Still drawn as the block that was edited, though its list is now the one another block has.
    expect(modelPaths(after, write.layout).find((path) => path.id === block.id)?.roles).toEqual([`pipeline-fix`, `refactor-run`]);
});

test(`editing the default writes one field and every job that follows it`, () => {
    const settings = { modelDefault: [], modelRoles: { "pipeline-fix": [opus] } };
    const [defaults] = modelPaths(settings, NONE);

    const after = applied(settings, editPath(settings, NONE, defaults!, [haiku]));

    expect(after.modelRoles).toEqual({ "pipeline-fix": [opus] });
    expect(rolePins(after, `commit-message`)).toEqual([haiku]);
    expect(rolePins(after, `pipeline-fix`)).toEqual([opus]);
});

test(`a job given its own models runs on what it did, in a block of its own that does not fold back`, () => {
    const settings = { modelDefault: [haiku], modelRoles: {} };
    const paths = modelPaths(settings, NONE);

    const write = moveJob(settings, NONE, paths, `session-title`, { kind: `own` }, mint);
    const after = applied(settings, write);

    expect(resolved(after)).toEqual(resolved(settings));
    const drawn = modelPaths(after, write.layout);
    expect(own(drawn)).toEqual([[`session-title`]]);
    expect(drawn[0]!.roles).not.toContain(`session-title`);
});

test(`moving a job onto another block gives it that block's list`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "pipeline-fix": [opus, sol] } };
    const paths = modelPaths(settings, NONE);
    const target = paths.find((path) => path.roles.includes(`pipeline-fix`))!;

    const write = moveJob(settings, NONE, paths, `loop-iteration`, { kind: `path`, id: target.id }, mint);
    const after = applied(settings, write);

    expect(rolePins(after, `loop-iteration`)).toEqual([opus, sol]);
    expect(own(modelPaths(after, write.layout))).toEqual([[`pipeline-fix`, `loop-iteration`]]);
});

test(`moving a job back to the default drops its own list rather than copying the default's`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "pipeline-fix": [opus] } };
    const paths = modelPaths(settings, NONE);

    const after = applied(settings, moveJob(settings, NONE, paths, `pipeline-fix`, { kind: `default` }, mint));

    expect(after.modelRoles).toEqual({});
});

test(`a job with no models joins the block that already has none`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "safety-judge": [] } };
    const paths = modelPaths(settings, NONE);

    const write = moveJob(settings, NONE, paths, `session-title`, { kind: `none` }, mint);
    const after = applied(settings, write);

    expect(rolePins(after, `session-title`)).toEqual([]);
    expect(own(modelPaths(after, write.layout))).toEqual([[`session-title`, `safety-judge`]]);
});

test(`a refused move draws the job back where it was`, () => {
    const settings = { modelDefault: [], modelRoles: { "pipeline-fix": [opus], "refactor-run": [opus], "acceptance-run": [sol] } };
    const paths = modelPaths(settings, NONE);
    const target = paths.find((path) => path.roles.includes(`acceptance-run`))!;

    // The layout moved, the settings did not.
    const { layout } = moveJob(settings, NONE, paths, `pipeline-fix`, { kind: `path`, id: target.id }, mint);

    expect(own(modelPaths(settings, layout))).toEqual([[`pipeline-fix`, `refactor-run`], [`acceptance-run`]]);
});

test(`making a block the default moves its jobs onto it and leaves every other job on what it ran`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "pipeline-fix": [opus, sol], "refactor-run": [opus, sol], "acceptance-run": [sol] } };
    const paths = modelPaths(settings, NONE);
    const block = paths.find((path) => path.roles.includes(`pipeline-fix`))!;

    const write = makeDefault(settings, NONE, paths, block, mint);
    const after = applied(settings, write);

    expect(resolved(after)).toEqual(resolved(settings));
    expect(after.modelDefault).toEqual([opus, sol]);
    const drawn = modelPaths(after, write.layout);
    expect(drawn[0]!.roles).toEqual([`pipeline-fix`, `refactor-run`]);
    // The old default's followers stay together, on the list they had.
    const kept = drawn.find((path) => path.roles.includes(`commit-message`))!;
    expect(kept.pins).toEqual([haiku]);
    expect(kept.roles).toEqual(paths[0]!.roles);
});

test(`following the default drops a block's own lists`, () => {
    const settings = { modelDefault: [haiku], modelRoles: { "pipeline-fix": [opus], "refactor-run": [opus], "acceptance-run": [sol] } };
    const paths = modelPaths(settings, NONE);
    const block = paths.find((path) => path.roles.includes(`pipeline-fix`))!;

    const after = applied(settings, followDefault(settings, NONE, block));

    expect(after.modelRoles).toEqual({ "acceptance-run": [sol] });
});
