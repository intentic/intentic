import { describe, expect, it } from "vitest";
import { recordTurnWrite, repoOfPath, turnWrites } from "./liveWrites";

describe(`repoOfPath`, () => {
    const repos = new Set([`intentic`, `apps`, `apps/web`]);

    it(`attributes a path to its repo`, () => {
        expect(repoOfPath(`intentic/src/main.ts`, repos)).toBe(`intentic`);
    });

    it(`prefers the deepest repo a path sits under`, () => {
        // A nested repo inside another repo: `apps/web/x.ts` belongs to the repo that actually holds it, and
        // the shorter id must not win just because it also matches.
        expect(repoOfPath(`apps/web/x.ts`, repos)).toBe(`apps/web`);
        expect(repoOfPath(`apps/api/x.ts`, repos)).toBe(`apps`);
    });

    it(`does not let "root" outrank a repo id shorter than it`, () => {
        expect(repoOfPath(`ui/x.ts`, new Set([`ui`]))).toBe(`ui`);
    });

    it(`falls back to root for a path no repo claims`, () => {
        expect(repoOfPath(`README.md`, repos)).toBe(`root`);
        // A prefix match must be on a directory boundary: `intentic-docs` is not inside `intentic`.
        expect(repoOfPath(`intentic-docs/x.md`, repos)).toBe(`root`);
    });
});

describe(`turn writes`, () => {
    const edit = (...paths: string[]) => ({ category: `edit` as const, locations: paths.map((path) => ({ path })) });

    it(`records the paths an edit touches`, () => {
        recordTurnWrite(`c1`, 100, edit(`intentic/a.ts`, `README.md`));
        expect([...turnWrites(`c1`, 100)]).toEqual([`intentic/a.ts`, `README.md`]);
    });

    it(`ignores tools that read rather than write`, () => {
        recordTurnWrite(`c2`, 100, { category: `read`, locations: [{ path: `a.ts` }] });
        // Bash reports no locations at all, so it can claim nothing either way.
        recordTurnWrite(`c2`, 100, { category: `execute` });
        expect(turnWrites(`c2`, 100).size).toBe(0);
    });

    it(`starts empty for a new turn instead of carrying the last one's paths`, () => {
        recordTurnWrite(`c3`, 100, edit(`old.ts`));
        expect([...turnWrites(`c3`, 200)]).toEqual([]);
        recordTurnWrite(`c3`, 200, edit(`new.ts`));
        expect([...turnWrites(`c3`, 200)]).toEqual([`new.ts`]);
    });

    it(`has nothing to report when no turn is running`, () => {
        recordTurnWrite(`c4`, 100, edit(`a.ts`));
        expect(turnWrites(`c4`, undefined).size).toBe(0);
    });

    it(`normalizes an explicit ./ lead so it can't read as a repo dir`, () => {
        recordTurnWrite(`c5`, 100, edit(`./intentic/a.ts`));
        expect([...turnWrites(`c5`, 100)]).toEqual([`intentic/a.ts`]);
    });
});
