// Property tests over quick-open ranking's laws (substring beats subsequence, basename beats directory) for every
// input. Matching cases are constructed from the path, not drawn and filtered, so the generators actually run.
import { array, assert, constantFrom, integer, nat, oneof, option, pre, property, stringMatching, tuple, uniqueArray } from "fast-check";
import { describe, expect, test } from "vitest";
import { fuzzyScore, rankPaths } from "./fuzzyPaths";

const segmentArb = stringMatching(/^[a-z0-9_-]{1,10}$/);

// Workspace-shaped paths, long enough that the substring floor and subsequence ceiling meet on long paths.
const pathArb = tuple(array(segmentArb, { minLength: 1, maxLength: 5 }), option(constantFrom(`ts`, `vue`, `md`, `py`), { nil: undefined }))
    .map(([segments, extension]) => segments.join(`/`) + (extension === undefined ? `` : `.${extension}`))
    .filter((path) => path.length > 0 && path.length <= 60);

const needleArb = stringMatching(/^[a-z0-9._/-]{0,12}$/);

// Needle sliced literally out of the path at a random offset, covering hits before the last slash.
const substringCaseArb = tuple(pathArb, nat(), integer({ min: 1, max: 12 }))
    .map(([path, offset, length]) => {
        const start = offset % path.length;
        return { needle: path.slice(start, start + length), path };
    })
    .filter(({ needle }) => needle.length > 0);

// Needle built as a genuine subsequence by picking path characters in order; drives the matching branch.
const subsequenceCaseArb = pathArb.chain((path) =>
    uniqueArray(nat({ max: path.length - 1 }), { minLength: 1, maxLength: Math.min(8, path.length) }).map((indices) => ({
        needle: indices
            .toSorted((a, b) => a - b)
            .map((index) => path[index]!)
            .join(``),
        path,
    })),
);

// Oracle definition of a match, written plainly so it shares no implementation with fuzzyScore's cursor loop under
// test.
const isSubsequence = (needle: string, haystack: string): boolean => {
    let index = 0;
    for (const character of haystack) {
        if (index < needle.length && character === needle[index]) {
            index++;
        }
    }
    return index === needle.length;
};

describe(`fuzzyScore`, () => {
    // Free needles mostly miss (false positives); constructed subsequences all match (false negatives).
    test.each([
        [`free needles`, tuple(needleArb, pathArb).map(([needle, path]) => ({ needle, path }))],
        [`constructed subsequences`, subsequenceCaseArb],
    ])(`is defined exactly when the needle is a case-insensitive subsequence that fits (%s)`, (_label, arb) => {
        assert(
            property(arb, ({ needle, path }) => {
                const matches = needle.length > 0 && needle.length <= path.length && isSubsequence(needle.toLowerCase(), path.toLowerCase());
                expect(fuzzyScore(needle, path) === undefined).toBe(!matches);
            }),
        );
    });

    // Run over matching needles only; non-matching ones would leave both sides undefined and prove nothing.
    test(`ignores the case of the needle`, () => {
        assert(
            property(subsequenceCaseArb, ({ needle, path }) => {
                expect(fuzzyScore(needle.toUpperCase(), path)).toBe(fuzzyScore(needle, path));
            }),
        );
    });

    test(`scores every non-empty path against itself, finitely and above zero`, () => {
        assert(
            property(pathArb, (path) => {
                const score = fuzzyScore(path, path);
                expect(score).toEqual(expect.any(Number));
                expect(Number.isFinite(score!)).toBe(true);
                expect(score!).toBeGreaterThan(0);
            }),
        );
    });

    test(`floors every literal substring match at 0.75`, () => {
        assert(
            property(substringCaseArb, ({ needle, path }) => {
                expect(fuzzyScore(needle, path)!).toBeGreaterThanOrEqual(0.75);
            }),
        );
    });

    test(`caps every scattered subsequence match at 0.7`, () => {
        assert(
            property(subsequenceCaseArb, ({ needle, path }) => {
                const score = fuzzyScore(needle, path);
                pre(score !== undefined && !path.toLowerCase().includes(needle.toLowerCase()));
                expect(score!).toBeLessThanOrEqual(0.7);
            }),
        );
    });
});

describe(`rankPaths`, () => {
    const queryArb = oneof(needleArb, segmentArb);

    // Same basename under sibling dirs from a disjoint alphabet: scores tie, isolating the tie-break.
    const tiedCaseArb = tuple(
        stringMatching(/^[a-w0-9_-]{1,10}$/),
        uniqueArray(stringMatching(/^[xyz]{3}$/), { minLength: 2, maxLength: 5 }),
        constantFrom(`ts`, `vue`),
    ).map(([name, directories, extension]) => ({ query: name, paths: directories.map((directory) => `${directory}/${name}.${extension}`) }));

    test(`breaks score ties by path, ascending`, () => {
        assert(
            property(tiedCaseArb, nat(), ({ query, paths }, rotation) => {
                const offset = rotation % paths.length;
                const rotated = [...paths.slice(offset), ...paths.slice(0, offset)];
                const ranked = rankPaths(query, rotated, paths.length);
                expect(new Set(ranked.map((path) => fuzzyScore(query, path))).size).toBe(1);
                expect(ranked).toEqual([...paths].toSorted());
            }),
        );
    });

    test(`returns a capped, duplicate-free subset of its input`, () => {
        assert(
            property(queryArb, array(pathArb, { maxLength: 25 }), integer({ min: 0, max: 30 }), (query, paths, limit) => {
                const ranked = rankPaths(query, paths, limit);
                expect(ranked.length).toBeLessThanOrEqual(limit);
                expect(new Set(ranked).size).toBe(ranked.length);
                for (const path of ranked) {
                    expect(paths).toContain(path);
                }
            }),
        );
    });

    test(`returns precisely the matching paths when the limit does not bind`, () => {
        assert(
            property(queryArb, uniqueArray(pathArb, { maxLength: 25 }), (query, paths) => {
                const ranked = rankPaths(query, paths, paths.length);
                const matching = paths.filter((path) => fuzzyScore(query, path) !== undefined);
                expect([...ranked].toSorted()).toEqual([...matching].toSorted());
            }),
        );
    });

    test(`orders by score, descending`, () => {
        assert(
            property(queryArb, uniqueArray(pathArb, { maxLength: 25 }), (query, paths) => {
                const scores = rankPaths(query, paths, paths.length).map((path) => fuzzyScore(query, path)!);
                for (let index = 1; index < scores.length; index++) {
                    expect(scores[index - 1]!).toBeGreaterThanOrEqual(scores[index]!);
                }
            }),
        );
    });

    test(`is independent of the order the paths arrive in`, () => {
        assert(
            property(queryArb, uniqueArray(pathArb, { maxLength: 25 }), integer({ min: 0, max: 30 }), nat(), (query, paths, limit, rotation) => {
                const offset = paths.length === 0 ? 0 : rotation % paths.length;
                const rotated = [...paths.slice(offset), ...paths.slice(0, offset)].toReversed();
                expect(rankPaths(query, rotated, limit)).toEqual(rankPaths(query, paths, limit));
            }),
        );
    });
});
