import type { ProcessReport } from "../../app/environments/processes/processReport";
import { mergeProcesses, processBadgeOf, processTileOf, processTilesOf } from "./processTiles";

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
