import type { ProcessReport } from "../../app/environments/processes/processReport";
import { foldedOnSandbox, mergeProcesses, processBadgeOf, processTileOf, processTilesOf, sandboxRunOf, settledSetups } from "./processTiles";

const run = (over: Partial<ProcessReport> = {}): ProcessReport => ({
    id: `sandbox-setup:sbx_7`,
    kind: `sandbox-setup`,
    state: `running`,
    origin: `app`,
    subject: `shop`,
    sandboxId: `sbx_7`,
    ...over,
});

describe(`a process's tile`, () => {
    it(`spins while it works, and says how far`, () => {
        const badge = processBadgeOf(run({ percent: 42 }));
        expect(badge?.running).toBe(`42% done`);
        expect(badge?.mark).toBeUndefined();
    });

    it(`marks a run that waits on the reader, one that failed, and one that is done`, () => {
        expect(processBadgeOf(run({ state: `waiting`, waitingFor: `consent` }))).toEqual({ mark: `exclamation-circle`, tone: `warning` });
        expect(processBadgeOf(run({ state: `failed` }))).toEqual({ mark: `exclamation-circle`, tone: `danger` });
        expect(processBadgeOf(run({ state: `done` }))).toEqual({ mark: `check`, tone: `info` });
    });

    it(`keeps spinning while it only waits on this PC's own setup`, () => {
        expect(processBadgeOf(run({ state: `waiting`, waitingFor: `pcSetup` }))?.running).toBe(`Waiting for this computer to be prepared`);
    });

    it(`wears the sandbox's letters for a sandbox's run, a glyph otherwise`, () => {
        expect(processTileOf(run()).glyph).toEqual({ logo: `shop` });
        expect(processTileOf(run({ id: `pc-setup:this`, kind: `pc-setup`, subject: undefined, sandboxId: undefined })).glyph).toEqual({ icon: `desktop` });
        expect(processTileOf(run()).title).toBe(`Setting up shop`);
    });
});

describe(`the rail's group`, () => {
    it(`leaves out a run the reader stopped, and what the face draws a tile of its own for`, () => {
        const tiles = processTilesOf(
            [run(), run({ id: `fix:a`, kind: `fix`, state: `stopped` }), run({ id: `sign-in:app`, kind: `sign-in`, state: `waiting`, waitingFor: `browser` })],
            (report) => report.kind === `sandbox-setup`,
        );
        expect(tiles.map((tile) => tile.id)).toEqual([`sign-in:app`]);
    });

    it(`merges lists, one per id, the later report winning and the first place kept`, () => {
        const merged = mergeProcesses([run(), run({ id: `docker:engine`, kind: `docker` })], [run({ state: `done` })]);
        expect(merged.map((report) => report.id)).toEqual([`sandbox-setup:sbx_7`, `docker:engine`]);
        expect(merged[0]?.state).toBe(`done`);
    });
});

describe(`one sandbox, one tile`, () => {
    const tiled = new Set([`sbx_7`]);

    it(`draws a working run of a sandbox already on the rail on that sandbox's tile, not in the group`, () => {
        expect(foldedOnSandbox(run(), tiled)).toBe(true);
        expect(foldedOnSandbox(run({ state: `waiting`, waitingFor: `pcSetup` }), tiled)).toBe(true);
        expect(sandboxRunOf([run({ percent: 80 })], `sbx_7`)?.percent).toBe(80);
    });

    it(`keeps a run that asks or failed in the group, its way to the page that answers it`, () => {
        expect(foldedOnSandbox(run({ state: `failed` }), tiled)).toBe(false);
        expect(foldedOnSandbox(run({ state: `waiting`, waitingFor: `consent` }), tiled)).toBe(false);
        expect(sandboxRunOf([run({ state: `failed` })], `sbx_7`)).toBeUndefined();
    });

    it(`leaves a sandbox the rail has no tile for in the group`, () => {
        expect(foldedOnSandbox(run({ sandboxId: `sbx_8` }), tiled)).toBe(false);
        expect(foldedOnSandbox(run({ sandboxId: undefined }), tiled)).toBe(false);
    });

    it(`hides a finished setup, which is put away, but not another run's "done"`, () => {
        expect(foldedOnSandbox(run({ state: `done` }), tiled)).toBe(true);
        expect(foldedOnSandbox(run({ id: `recreate:sbx_7`, kind: `recreate`, state: `done` }), tiled)).toBe(false);
    });

    it(`puts away a finished setup for a sandbox the reader has, here or the one they are in`, () => {
        const done = run({ state: `done` });
        expect(settledSetups([done, run({ id: `sandbox-setup:sbx_9`, sandboxId: `sbx_9`, state: `done` })], tiled, undefined)).toEqual([done]);
        expect(settledSetups([done], new Set(), `sbx_7`)).toEqual([done]);
        expect(settledSetups([run()], tiled, undefined)).toEqual([]);
    });
});
