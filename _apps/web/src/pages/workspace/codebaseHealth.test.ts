import { describe, expect, it } from "vitest";
import type { WorkspaceHotspot } from "@intentic-app/api-contract";
import { formatCount, hotspotRows, perFile, splitPath } from "./codebaseHealth";

const hotspot = (path: string, score: number): WorkspaceHotspot => ({
    path,
    commits: 1,
    adds: 10,
    dels: 2,
    complexity: score,
    score,
    latestMs: 0,
});

describe(`hotspotRows`, () => {
    it(`scales every bar against the leader, not an axis`, () => {
        const rows = hotspotRows([hotspot(`a.ts`, 100), hotspot(`b.ts`, 50), hotspot(`c.ts`, 25)]);
        expect(rows.map((row) => row.share)).toEqual([1, 0.5, 0.25]);
    });

    it(`keeps the tail visible — a file that placed at all still draws a bar`, () => {
        // 1/1000 of the leader would round to nothing on screen, and an empty track reads as "no risk" rather
        // than "far less than the leader".
        const [, tail] = hotspotRows([hotspot(`a.ts`, 1000), hotspot(`b.ts`, 1)]);
        expect(tail!.share).toBeGreaterThan(0);
        expect(tail!.share).toBeLessThan(0.05);
    });

    it(`splits the path so truncation eats the directory, never the filename`, () => {
        const [row] = hotspotRows([hotspot(`_apps/web/src/App.vue`, 4)]);
        expect(row).toMatchObject({ dir: `_apps/web/src/`, name: `App.vue` });
        expect(splitPath(`README.md`)).toEqual({ dir: ``, name: `README.md` });
    });

    it(`survives an empty ranking`, () => {
        expect(hotspotRows([])).toEqual([]);
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
