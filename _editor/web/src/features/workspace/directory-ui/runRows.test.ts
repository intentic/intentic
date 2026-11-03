import type { PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import { RunTargetsFileSchema, type RepoRunTargets } from "@intentic/sandbox-contract/schemas/run-targets";
import { appTargets, appTargetId, repoTargets, repoTargetId } from "../../../models/preview/previewModel";
import { defaultPlace, FOUND, openingPlace, placesOf, provenanceOf, runRowsOf, runsAt, SANDBOX } from "./runRows";

// The Run dialog's rows: every target the repository's run.json declares, each runnable where it says (a command in the
// sandbox, an artifact on a computer), and, when the file says nothing for the sandbox, what Start finds there.

const panel = (over: Partial<PanelSummary>): PanelSummary => ({
    repo: `shop`,
    hasPanel: true,
    installed: true,
    running: false,
    healthy: false,
    servers: [],
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    tests: false,
    userStories: false,
    docs: false,
    ...over,
});

const declared = (targets: unknown[]): RepoRunTargets => ({
    repo: `shop`,
    path: `shop/.intentic/run.json`,
    targets: RunTargetsFileSchema.parse({ targets }).targets,
});

const FILE = declared([
    { name: `web`, command: `pnpm dev`, description: `The shop` },
    { name: `desktop`, device: `rog`, artifact: `out/shop.exe`, isolated: true },
    { name: `game`, command: `cargo run`, artifact: `target/game.exe` },
]);

test(`each declared target runs where it says: a command in the sandbox, an artifact on a computer, both in either`, () => {
    const live = appTargets(`shop`, [{ app: `web`, command: `pnpm dev`, running: true, healthy: true, installed: true }]);
    const rows = runRowsOf(`shop`, FILE, panel({ start: { from: `dev`, command: `pnpm dev` } }), live);
    expect(rows.map((row) => [row.key, runsAt(row, SANDBOX), runsAt(row, `rog`)])).toEqual([
        [`web`, true, false],
        [`desktop`, false, true],
        [`game`, true, true],
    ]);
    // What Start finds is not offered beside a file that already says how the sandbox runs it.
    expect(rows.some((row) => row.key === FOUND)).toBe(false);
    expect(rows[0]?.sandboxId).toBe(appTargetId(`shop`, `web`));
    expect(rows[0]?.sandbox?.running).toBe(true);
    // Listed before the apps read answers: named, not yet runnable.
    expect(rows[2]?.sandboxId).toBe(appTargetId(`shop`, `game`));
    expect(rows[2]?.sandbox).toBeUndefined();
});

test(`a repository whose file says nothing for the sandbox offers what Start finds, first`, () => {
    const repo = panel({ start: { from: `cargo`, command: `cargo run -p game` } });
    const rows = runRowsOf(`shop`, declared([{ name: `desktop`, artifact: `out/shop.exe` }]), repo, repoTargets([repo]));
    expect(rows.map((row) => row.key)).toEqual([FOUND, `desktop`]);
    expect(rows[0]).toMatchObject({ name: `cargo run -p game`, found: `cargo`, sandboxId: repoTargetId(`shop`) });
    expect(rows[0]?.sandbox?.builds).toBe(true);
    // No run.json at all still runs in the sandbox; nothing to run anywhere lists nothing.
    expect(runRowsOf(`shop`, undefined, repo, []).map((row) => row.key)).toEqual([FOUND]);
    expect(runRowsOf(`shop`, undefined, panel({ hasPanel: false }), [])).toEqual([]);
});

test(`the dialog opens on the first row's own place, else on a computer that can take a run`, () => {
    const devices = [`omen`, `rog`];
    const rows = runRowsOf(`shop`, FILE, undefined, []);
    expect(defaultPlace(rows, devices, () => true)).toBe(SANDBOX);
    const computerFirst = runRowsOf(`shop`, declared([{ name: `desktop`, device: `rog`, artifact: `a.exe` }]), undefined, []);
    expect(defaultPlace(computerFirst, devices, () => true)).toBe(`rog`);
    expect(defaultPlace(computerFirst, devices, (id) => id === `omen`)).toBe(`omen`);
    expect(defaultPlace(computerFirst, [], () => true)).toBe(SANDBOX);
    expect(defaultPlace([], devices, () => true)).toBe(SANDBOX);
});

test(`only places with something to run are offered, and the one picked last opens again while it still is`, () => {
    const devices = [`omen`, `rog`];
    const rows = runRowsOf(`shop`, FILE, undefined, []);
    expect(placesOf(rows, devices)).toEqual([SANDBOX, `omen`, `rog`]);
    // Nothing carries a build to a computer: no computer is offered, and a sandbox-only file offers the sandbox alone.
    const sandboxOnly = runRowsOf(`shop`, declared([{ name: `web`, command: `pnpm dev` }]), undefined, []);
    expect(placesOf(sandboxOnly, devices)).toEqual([SANDBOX]);
    const computerOnly = runRowsOf(`shop`, declared([{ name: `desktop`, artifact: `a.exe` }]), undefined, []);
    expect(placesOf(computerOnly, devices)).toEqual(devices);
    expect(placesOf(computerOnly, [])).toEqual([]);

    // The pick outlives the dialog, a computer asleep today included; one no longer offered falls back to the default.
    const asleep = (): boolean => false;
    expect(openingPlace(rows, devices, asleep, `rog`)).toBe(`rog`);
    expect(openingPlace(rows, devices, () => true, undefined)).toBe(SANDBOX);
    expect(openingPlace(rows, devices, () => true, `gone`)).toBe(SANDBOX);
    expect(openingPlace(sandboxOnly, devices, () => true, `rog`)).toBe(SANDBOX);
});

test(`an open row says what it runs: the command in the sandbox, the build made for a computer`, () => {
    const rows = runRowsOf(
        `shop`,
        declared([{ name: `game`, command: `cargo run`, build: `cargo build --release`, artifact: `target/game.exe` }]),
        undefined,
        [],
    );
    expect(rows[0]).toMatchObject({ command: `cargo run`, build: `cargo build --release` });
});

// "Am I running the up-to-date version?": a run says what it was built from, and is stale once work landed after it.
test("a computer's run says the commit it was built from, and is stale once work landed after it or the tree moved under it", () => {
    const run = {
        device: `rog`,
        id: `server-1a2b3c`,
        name: `server`,
        state: `running` as const,
        said: `running, pid 1`,
        startedAt: `2026-11-02T15:30:00.000Z`,
        ports: [],
        builtFrom: { commit: `abc1234def567`, changed: 3, at: `2026-11-02T15:29:00.000Z` },
    };
    expect(provenanceOf(run)).toEqual({ commit: `abc1234`, changed: 3, at: Date.parse(`2026-11-02T15:29:00.000Z`), lands: 0, moved: false, stale: false });
    expect(provenanceOf({ ...run, landsSince: 2 })).toMatchObject({ lands: 2, stale: true });
    expect(provenanceOf({ ...run, builtFrom: { ...run.builtFrom, movedDuringBuild: true } })).toMatchObject({ lands: 0, moved: true, stale: true });
    // A run built before this sandbox last came up, or not by `devices run`, says nothing about it.
    expect(provenanceOf({ ...run, builtFrom: undefined })).toBeUndefined();
    expect(provenanceOf(undefined)).toBeUndefined();
});
