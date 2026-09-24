import { pathRanker } from "./fuzzyPaths";

const rankPaths = (query: string, paths: readonly string[], limit: number): string[] => pathRanker(limit)(query, paths);

const PATHS = [`alpha/src/widget.ts`, `alpha/src/registry.ts`, `beta/app.py`, `notes.md`];

test(`rankPaths ranks best match first, deterministically on ties, capped at limit`, () => {
    expect(rankPaths(`widget`, PATHS, 100)).toEqual([`alpha/src/widget.ts`]);
    // `re` is a basename substring in registry.ts and only a scattered subsequence in widget.ts.
    expect(rankPaths(`re`, PATHS, 100)).toEqual([`alpha/src/registry.ts`, `alpha/src/widget.ts`]);
    expect(rankPaths(`re`, PATHS, 100)).toEqual(rankPaths(`re`, PATHS.toReversed(), 100));
    // The shortest path wins `a`, so the cap drops registry.ts rather than the tail of the input.
    expect(rankPaths(`a`, PATHS, 2)).toEqual([`beta/app.py`, `alpha/src/widget.ts`]);
    expect(rankPaths(`zzz`, PATHS, 100)).toEqual([]);
});

test(`a repeated path is ranked once, so a duplicate cannot displace the next-best match under the cap`, () => {
    expect(rankPaths(`a`, [...PATHS, `beta/app.py`, `beta/app.py`], 3)).toEqual([`beta/app.py`, `alpha/src/widget.ts`, `alpha/src/registry.ts`]);
});

test(`a ranker kept across keystrokes answers each one as a fresh ranking would`, () => {
    const rank = pathRanker(100);
    for (const query of [`a`, `al`, `alp`, `al`, `re`, `reg`]) {
        expect(rank(query, PATHS)).toEqual(rankPaths(query, PATHS, 100));
    }
});
