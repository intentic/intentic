import type { PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import { RunTargetsFileSchema, type RepoRunTargets } from "@intentic/sandbox-contract/schemas/run-targets";
import { appTargets, appTargetId, repoTargets, repoTargetId } from "../../models/preview/previewModel";
import { FOUND, provenanceOf, runRowsOf, runsAt, SANDBOX } from "./runRows";

// What a repository can run: every target the repository's run.json declares, each runnable where it says (a command in the
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
