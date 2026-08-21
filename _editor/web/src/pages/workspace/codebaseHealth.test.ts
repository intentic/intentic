import { describe, expect, it } from "vitest";
import type { WorkspaceHotspot } from "@intentic-app/api-contract";
import { formatCount, hotspotRows, median, moduleRows, perFile, splitPath } from "./codebaseHealth";

const hotspot = (path: string, score: number): WorkspaceHotspot => ({
    path,
    commits: 1,
    adds: 10,
    dels: 2,
    complexity: score,
    score,
    latestMs: 0,
});

// `latestMs: 0` above is the epoch, so a fixture row is dormant unless it says otherwise, the honest default
// for a file with no history behind it.
const NOW = 1_700_000_000_000;

describe(`hotspotRows`, () => {
    it(`scales every bar against the leader, not an axis`, () => {
        const rows = hotspotRows([hotspot(`a.ts`, 100), hotspot(`b.ts`, 50), hotspot(`c.ts`, 25)], [], `all`, NOW);
        expect(rows.map((row) => row.share)).toEqual([1, 0.5, 0.25]);
    });

    it(`keeps the tail visible: a file that placed at all still draws a bar`, () => {
        // 1/1000 of the leader would round to nothing on screen, and an empty track reads as "no risk" rather
        // than "far less than the leader".
        const [, tail] = hotspotRows([hotspot(`a.ts`, 1000), hotspot(`b.ts`, 1)], [], `all`, NOW);
        expect(tail!.share).toBeGreaterThan(0);
        expect(tail!.share).toBeLessThan(0.05);
    });

    it(`splits the path so truncation eats the directory, never the filename`, () => {
        const [row] = hotspotRows([hotspot(`_editor/web/src/App.vue`, 4)], [], `all`, NOW);
        expect(row).toMatchObject({ dir: `_editor/web/src/`, name: `App.vue` });
        expect(splitPath(`README.md`)).toEqual({ dir: ``, name: `README.md` });
    });

    it(`survives an empty ranking`, () => {
        expect(hotspotRows([], [], `all`, NOW)).toEqual([]);
        expect(moduleRows([])).toEqual([]);
    });

    it(`takes each signal's share against the largest in the list, not against the top row`, () => {
        // The ranking sorts by the product, so the file with the most COMMITS need not be first: b.ts holds all
        // the churn here, and reading its share against a.ts's 1 commit would call it 20× the leader.
        const rows = hotspotRows(
            [
                { ...hotspot(`a.ts`, 200), commits: 1, complexity: 200 },
                { ...hotspot(`b.ts`, 100), commits: 20, complexity: 5 },
            ],
            [],
            `all`,
            NOW,
        );
        // a.ts: all of the branching, a twentieth of the churn. b.ts: the reverse.
        expect(rows.map((row) => row.ask.kind)).toEqual([`simplify`, `split`]);
    });

    it(`reads a hotspot that is also a key module as a stability problem`, () => {
        const rows = hotspotRows([hotspot(`a.ts`, 100)], [{ path: `a.ts`, exports: 3 }], `all`, NOW);
        expect(rows[0]!.ask.kind).toBe(`stabilize`);
    });

    it(`offers the refactor on every row, dormant or not`, () => {
        const rows = hotspotRows([hotspot(`a.ts`, 100), { ...hotspot(`b.ts`, 50), latestMs: NOW }], [], `all`, NOW);
        expect(rows.map((row) => row.ask.dormant)).toEqual([true, false]);
        expect(rows.every((row) => row.ask.prompt.includes(row.path))).toBe(true);
    });
});

describe(`moduleRows`, () => {
    it(`offers the refactor only where the export surface dwarfs its peers`, () => {
        const rows = moduleRows([
            { path: `src/index.ts`, exports: 4 },
            { path: `src/schemas.ts`, exports: 428 },
            { path: `src/util.ts`, exports: 12 },
        ]);
        expect(rows.map((row) => row.ask?.kind)).toEqual([undefined, `narrow`, undefined]);
        expect(rows[1]).toMatchObject({ dir: `src/`, name: `schemas.ts` });
    });
});

describe(`median`, () => {
    it(`takes the middle of a set of counts, averaging the pair in an even one`, () => {
        expect(median([4, 1, 9])).toBe(4);
        expect(median([1, 2, 3, 10])).toBe(2.5);
        expect(median([])).toBe(0);
    });
});

describe(`formatCount`, () => {
    it(`stays exact while the number fits, then compacts`, () => {
        expect(formatCount(0)).toBe(`0`);
        expect(formatCount(9999)).toBe(`9,999`);
        expect(formatCount(12_400)).toBe(`12,400`);
        expect(formatCount(2_450_000)).toBe(`2.5M`);
    });
});

describe(`perFile`, () => {
    it(`gives complexity its denominator, and says nothing when there is none`, () => {
        expect(perFile(880, 100)).toBe(`8.8`);
        expect(perFile(0, 0)).toBe(`—`);
    });
});
