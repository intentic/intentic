// Property tests over quick-open ranking's laws (cap, dedupe, tie-break, order-independence) for every input.
// The scorer's own laws are @intentic/base/fuzzy's, tested there; here it is only the oracle ranking is judged by.
import { array, assert, constantFrom, integer, nat, oneof, option, property, stringMatching, tuple, uniqueArray } from "fast-check";
import { fuzzyScore } from "@intentic/base/fuzzy";
import { describe, test, expect } from "bun:test";
import { rankPaths } from "./fuzzyPaths";

const segmentArb = stringMatching(/^[a-z0-9_-]{1,10}$/);

// Workspace-shaped paths, long enough that the ranker sees ties and near-ties rather than one obvious winner.
const pathArb = tuple(array(segmentArb, { minLength: 1, maxLength: 5 }), option(constantFrom(`ts`, `vue`, `md`, `py`), { nil: undefined }))
    .map(([segments, extension]) => segments.join(`/`) + (extension === undefined ? `` : `.${extension}`))
    .filter((path) => path.length > 0 && path.length <= 60);

const needleArb = stringMatching(/^[a-z0-9._/-]{0,12}$/);

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
