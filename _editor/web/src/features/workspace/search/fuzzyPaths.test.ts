import { expect, test } from "vitest";
import { rankPaths } from "./fuzzyPaths";

const PATHS = [`alpha/src/widget.ts`, `alpha/src/registry.ts`, `beta/app.py`, `notes.md`];

test(`rankPaths ranks best match first, deterministically on ties, capped at limit`, () => {
    expect(rankPaths(`widget`, PATHS, 100)[0]).toBe(`alpha/src/widget.ts`);
    expect(rankPaths(`re`, PATHS, 100)).toEqual(rankPaths(`re`, PATHS.toReversed(), 100));
    expect(rankPaths(`a`, PATHS, 2)).toHaveLength(2);
    expect(rankPaths(`zzz`, PATHS, 100)).toEqual([]);
});

test(`a repeated path is ranked once, so a duplicate cannot displace the next-best match under the cap`, () => {
    expect(rankPaths(`a`, [...PATHS, `beta/app.py`, `beta/app.py`], 3)).toEqual(rankPaths(`a`, PATHS, 3));
});
