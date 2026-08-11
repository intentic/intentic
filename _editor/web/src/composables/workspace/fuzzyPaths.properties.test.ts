/* PROPERTY TESTS over quick-open's ranking. fuzzyPaths.test.ts pins the behaviour a person can name — that a
 * substring beats a scattered subsequence, that a basename beats a directory. This file pins the laws that
 * have to hold for EVERY input, which is where the example-based half is blind: the scoring loop walks the
 * haystack with a cursor that only moves forward, and the ways to get that wrong (a repeated character, a
 * match that would need to backtrack, a hit before the last slash rather than in the basename) are exactly
 * the inputs nobody thinks to write down.
 *
 * THE GENERATORS DO THE REAL WORK HERE, and getting them wrong is how a property test passes while testing
 * nothing. A randomly generated needle is a subsequence of a randomly generated path almost never, so drawing
 * both independently and filtering leaves every interesting branch unvisited — an earlier draft of this file
 * scored green against a fuzzyScore whose case handling had been deleted, purely because its needles never
 * matched anything. So the matching cases below are CONSTRUCTED out of the path rather than hoped for, and
 * paths are built from slash-joined segments rather than free strings, because a directory separator is what
 * the basename and boundary rules are about.
 *
 * fast-check shrinks a failure to the smallest input that still fails, and prints the seed to replay it. */
import { array, assert, constantFrom, integer, nat, oneof, option, pre, property, stringMatching, tuple, uniqueArray } from "fast-check";
import { describe, expect, test } from "vitest";
import { fuzzyScore, rankPaths } from "./fuzzyPaths";

const segmentArb = stringMatching(/^[a-z0-9_-]{1,10}$/);

// Workspace-shaped paths: a few segments and a separator, sometimes an extension. Long enough to matter — the
// substring floor and the subsequence ceiling sit closest together on long paths, so short-only paths would
// hide a regression in exactly the place the two branches meet.
const pathArb = tuple(array(segmentArb, { minLength: 1, maxLength: 5 }), option(constantFrom(`ts`, `vue`, `md`, `py`), { nil: undefined }))
    .map(([segments, extension]) => segments.join(`/`) + (extension === undefined ? `` : `.${extension}`))
    .filter((path) => path.length > 0 && path.length <= 60);

const needleArb = stringMatching(/^[a-z0-9._/-]{0,12}$/);

// A pair whose needle appears LITERALLY in the path, sliced straight out of it. The slice starts anywhere, so
// this covers the hit-before-the-last-slash case that a hand-written example almost never reaches.
const substringCaseArb = tuple(pathArb, nat(), integer({ min: 1, max: 12 }))
    .map(([path, offset, length]) => {
        const start = offset % path.length;
        return { needle: path.slice(start, start + length), path };
    })
    .filter(({ needle }) => needle.length > 0);

// A pair whose needle is a genuine subsequence, built by picking characters out of the path in order. This is
// the generator that makes the matching branch actually run.
const subsequenceCaseArb = pathArb.chain((path) =>
    uniqueArray(nat({ max: path.length - 1 }), { minLength: 1, maxLength: Math.min(8, path.length) }).map((indices) => ({
        needle: indices
            .toSorted((a, b) => a - b)
            .map((index) => path[index]!)
            .join(``),
        path,
    })),
);

// The reference definition of "matches", written the obvious way rather than the fast way. fuzzyScore's own
// cursor loop is the thing under test, so the oracle it is checked against must not share its implementation.
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
    // THE CONTRACT. `undefined` means "not a match" and a number means "a match", and the only definition of a
    // match is a case-insensitive subsequence that fits. Both directions matter: a false negative hides a file
    // the reader asked for, a false positive puts noise at the top of quick-open. Checked over free needles
    // (mostly non-matches, which is the false-positive half) and over constructed ones (all matches, which is
    // the false-negative half).
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

    // Only the needle is lowercased inside fuzzyScore; the haystack's original case is read for the
    // camelCase-boundary bonus. So the needle's case must not move the score. Run over needles that MATCH —
    // over non-matching ones both sides are undefined and the property proves nothing.
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
                expect(score).toBeDefined();
                expect(Number.isFinite(score!)).toBe(true);
                expect(score!).toBeGreaterThan(0);
            }),
        );
    });

    // THE ORDERING QUICK-OPEN IS BUILT ON, as two halves that meet in the gap between 0.7 and 0.75: a literal
    // hit never scores below 0.75, and a scattered one never reaches it. Together they say a substring match
    // always outranks a subsequence match — the thing the example suite checks with two hand-picked pairs.
    test(`floors every literal substring match at 0.75`, () => {
        assert(
            property(substringCaseArb, ({ needle, path }) => {
                expect(fuzzyScore(needle, path)!).toBeGreaterThanOrEqual(0.75);
            }),
        );
    });

    // Per matched character the subsequence branch can earn at most 1 + 0.8 + 0.6, and it divides by exactly
    // that before scaling by 0.7 — so 0.7 is a ceiling no scattered match can pass.
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

    // Paths that DELIBERATELY SCORE THE SAME: one basename under sibling directories of equal length. Score
    // depends on the path's length and on where the first hit falls, and these agree on both — so the only
    // thing left to order them is the tie-break, and a test that never produces a tie cannot see it.
    //
    // The directory alphabet is disjoint from the name's on purpose. Drawn from the same letters, a query can
    // match inside the DIRECTORY of one sibling and the basename of another, which moves the basename bonus
    // and unties the scores — `{query: "a", paths: ["aaa/a.ts", "bbb/a.ts"]}` is what this generator produced
    // before the split, and those two genuinely differ.
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
                // Every one of these scores identically, so the whole answer must be the paths in sorted order.
                expect(new Set(ranked.map((path) => fuzzyScore(query, path))).size).toBe(1);
                expect(ranked).toEqual([...paths].toSorted());
            }),
        );
    });

    // Ranking may reorder and truncate. It may never invent a path, duplicate one, or return more than asked
    // for — the three ways a result list can lie about the workspace.
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

    // Every returned path scores, and — when the limit is not binding — every scoring path is returned. The
    // second half is what stops a filter bug from quietly dropping matches the reader was looking for.
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

    // The example suite checks this against one reversed array. A tie between equal scores is broken by path
    // ascending, so the answer must not depend on the order the workspace happened to hand the paths over in —
    // for any permutation, not just the one that was easy to type.
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
