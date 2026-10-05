import { reapDigestLines, shapeDigestLines } from "./retention.js";

// What the daily sweeps leave for a human, as the admin digest words it (retention.ts, 2026-10-05).

const nothingReaped = { destroyed: [], deferred: [], refused: [], forgotten: [], skipped: {} };
const nothingShaped = { apps: 0, destroyed: [], deferred: [], foreignMachines: [], strayVolumes: [], rowMachineMissing: [], waiting: 0 };

describe(`the digest's sweep lines`, () => {
    it(`say nothing about a pass that left nothing for anyone`, () => {
        expect(reapDigestLines({ ...nothingReaped, destroyed: [`intentic-sbx-a`] })).toEqual([]);
        expect(shapeDigestLines({ ...nothingShaped, destroyed: [`intentic-sbx-a/m1`] })).toEqual([]);
    });

    it(`name the apps of sandboxes this database has no record of, and a refused pass as urgent`, () => {
        const lines = reapDigestLines({ ...nothingReaped, forgotten: [`intentic-sbx-a`, `intentic-sbx-b`], refused: [`intentic-sbx-c`] });
        expect(lines.map((line) => line.severity)).toEqual([`danger`, `warning`]);
        expect(lines[1]?.title).toBe(`2 hosted app(s) belong to sandboxes this database has no record of`);
        expect(lines[1]?.detail).toContain(`intentic-sbx-a, intentic-sbx-b`);
    });

    it(`shorten a long list rather than mail every name`, () => {
        const forgotten = Array.from({ length: 12 }, (_, index) => `intentic-sbx-${index}`);
        expect(reapDigestLines({ ...nothingReaped, forgotten })[0]?.detail).toContain(`and 4 more`);
    });

    it(`name what the app-shape check would not touch`, () => {
        const lines = shapeDigestLines({ ...nothingShaped, foreignMachines: [`intentic-sbx-a/m9`], strayVolumes: [`intentic-sbx-a/vol_old`] });
        expect(lines.map((line) => line.title)).toEqual([
            `1 machine(s) this platform did not make are in sandboxes' apps`,
            `1 volume(s) in sandboxes' apps are not the disk their row names`,
        ]);
    });
});
