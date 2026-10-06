import type { EngineHit } from "../types.js";
import { CONFIDENCE_MARGIN, CONFIDENT_FLOOR, confidenceOf, fieldMargin, fieldScores, WEAK_FLOOR } from "./verdict.js";

const hit = (path: string, line: number): EngineHit => ({ path, line, text: "code", tags: [] });
const scored = (entries: readonly [string, number, number][]): { hit: EngineHit; logit: number }[] =>
    entries.map(([path, line, logit]) => ({ hit: hit(path, line), logit }));
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// The bug this replaced: the margin was the gap between the top two PASSAGES. Two hits in one file resolve to
// the same chunk, so the cross-encoder scored the same text twice and the gap collapsed to zero — a file that
// matched well twice was reported as a flat field. 65% of answers in the 2026-09 mining said "ambiguous".
test("a file that matches well twice stays confident; its own second hit is not its rival", () => {
    const ordered = [{ path: "src/scheduler.ts" }, { path: "docs/notes.md" }];
    const entries = scored([
        ["src/scheduler.ts", 119, 3],
        ["src/scheduler.ts", 121, 3],
        ["docs/notes.md", 4, -3],
    ]);
    // Passage-to-passage would be sigmoid(3) - sigmoid(3) = 0. File-to-file compares the two distinct files.
    expect(fieldMargin(ordered, entries)).toBeGreaterThan(CONFIDENCE_MARGIN);
});

test("a genuinely flat field is still ambiguous", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    const entries = scored([
        ["src/a.ts", 1, 0.5],
        ["src/b.ts", 1, 0.49],
    ]);
    expect(fieldMargin(ordered, entries)).toBeLessThan(CONFIDENCE_MARGIN);
});

test("the margin compares the two leading files of the displayed order, not the best two scores anywhere", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }];
    const entries = scored([
        ["src/a.ts", 1, 3],
        ["src/b.ts", 1, -3],
        // A high scorer ranked third by the RRF blend must not be mistaken for the runner-up.
        ["src/c.ts", 1, 2.9],
    ]);
    expect(fieldMargin(ordered, entries)).toBeCloseTo(sigmoid(3) - sigmoid(-3), 10);
    expect(fieldScores(ordered, entries)).toEqual({ top: sigmoid(3), runnerUp: sigmoid(-3) });
});

test("a runner-up that never reached the cross-encoder reads as the widest gap, not as missing data", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/unscored.ts" }];
    expect(fieldMargin(ordered, scored([["src/a.ts", 1, 1]]))).toBe(1);
    expect(fieldScores(ordered, scored([["src/a.ts", 1, 1]])).runnerUp).toBeUndefined();
});

test("no reranked leader means no signal to report", () => {
    expect(fieldMargin([{ path: "src/a.ts" }], scored([["src/other.ts", 1, 1]]))).toBe(0);
    expect(fieldMargin([], scored([]))).toBe(0);
});

// The floor is absolute: the margin says which file leads, the floor whether any of them answers at all, and the top
// score whether the leader answers on its own.
describe("confidenceOf", () => {
    const strong = { top: 0.95, margin: 0.9, relevance: 0.95 };

    test("a wide margin below the floor is weak: a clear gap between two non-answers is still no answer", () => {
        expect(confidenceOf({ ...strong, relevance: WEAK_FLOOR - 0.0001 })).toBe("weak");
    });

    test("the floor itself clears: weak is strictly below it", () => {
        expect(confidenceOf({ ...strong, relevance: WEAK_FLOOR })).not.toBe("weak");
    });

    test("a query naming a defined identifier is never weak: what it asks about exists", () => {
        expect(confidenceOf({ top: 0, margin: 0, relevance: 0, named: true })).toBe("ambiguous");
    });

    // The 2026-10 mining: `iq "serialize concurrent operations per key queue lock"` answered Cargo.lock:71 as confident
    // at rerank 0.04. A lead over a weaker runner-up is not an answer on its own.
    test("a leader that scores low on its own is not confident, however far ahead of the runner-up", () => {
        expect(confidenceOf({ top: CONFIDENT_FLOOR - 0.01, margin: 1, relevance: CONFIDENT_FLOOR - 0.01 })).toBe("ambiguous");
    });

    test("a strong leader clearly ahead is confident; one level with the runner-up is ambiguous", () => {
        expect(confidenceOf({ top: CONFIDENT_FLOOR, margin: CONFIDENCE_MARGIN, relevance: CONFIDENT_FLOOR })).toBe("confident");
        expect(confidenceOf({ top: CONFIDENT_FLOOR, margin: CONFIDENCE_MARGIN - 0.001, relevance: CONFIDENT_FLOOR })).toBe("ambiguous");
    });

    test("weak wins over ambiguous when both hold", () => {
        expect(confidenceOf({ top: 0, margin: 0, relevance: 0 })).toBe("weak");
    });
});
