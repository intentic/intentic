import { expect, test } from "vitest";
import { fuzzyScore, rankPaths } from "./fuzzyPaths";

const PATHS = [`alpha/src/widget.ts`, `alpha/src/registry.ts`, `beta/app.py`, `notes.md`];

test(`fuzzyScore: substring beats subsequence, basename beats dir match`, () => {
    expect(fuzzyScore(`widget`, `alpha/src/widget.ts`)!).toBeGreaterThan(fuzzyScore(`wdgt`, `alpha/src/widget.ts`)!);
    expect(fuzzyScore(`src`, `alpha/src/widget.ts`)!).toBeLessThan(fuzzyScore(`widget`, `alpha/src/widget.ts`)!);
    expect(fuzzyScore(`zzz`, `notes.md`)).toBeUndefined();
    expect(fuzzyScore(``, `notes.md`)).toBeUndefined();
});

test(`rankPaths ranks best match first, deterministically on ties, capped at limit`, () => {
    expect(rankPaths(`widget`, PATHS, 100)[0]).toBe(`alpha/src/widget.ts`);
    expect(rankPaths(`re`, PATHS, 100)).toEqual(rankPaths(`re`, PATHS.toReversed(), 100));
    expect(rankPaths(`a`, PATHS, 2)).toHaveLength(2);
    expect(rankPaths(`zzz`, PATHS, 100)).toEqual([]);
});
