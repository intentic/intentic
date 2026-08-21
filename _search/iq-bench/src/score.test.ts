import type { WorkspaceSearchResult } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { rankedAnchors, scoreCase } from "./score.js";

const result = (groups: Array<{ path: string; lines: number[] }>, related?: string[], candidates?: string[]): WorkspaceSearchResult => ({
    mode: "q",
    total: groups.length,
    files: groups.length,
    shown: groups.length,
    groups: groups.map((group) => ({ path: group.path, score: 1, hits: group.lines.map((line) => ({ line, text: "x", spans: [], tags: [] })) })),
    freshness: { state: "fresh" },
    truncated: false,
    ...(related !== undefined ? { related } : {}),
    ...(candidates !== undefined ? { candidates } : {}),
});

describe("rankedAnchors", () => {
    it("flattens groups in rank order and appends related definition anchors", () => {
        const anchors = rankedAnchors(result([{ path: "a.ts", lines: [3, 9] }], ["createWidget, def b.ts:42 · refs: iq refs createWidget"]));
        expect(anchors).toEqual([
            { file: "a.ts", lines: [3, 9] },
            { file: "b.ts", lines: [42] },
        ]);
    });

    it("skips related lines without a parsable anchor", () => {
        expect(rankedAnchors(result([], ["garbage"]))).toEqual([]);
    });

    it("ranks the candidates' path:line anchors after the groups", () => {
        const anchors = rankedAnchors(result([{ path: "a.ts", lines: [3] }], undefined, ["b.ts:12", "c.ts:88"]));
        expect(anchors).toEqual([
            { file: "a.ts", lines: [3] },
            { file: "b.ts", lines: [12] },
            { file: "c.ts", lines: [88] },
        ]);
    });

    it("a candidate anchor satisfies a line-anchored expectation within tolerance", () => {
        const predicted = rankedAnchors(result([], undefined, ["b.ts:320"]));
        expect(scoreCase([{ file: "b.ts", line: 323, tolerance: 60 }], predicted).recallAt5).toBe(1);
        expect(scoreCase([{ file: "b.ts", line: 900, tolerance: 10 }], predicted).recallAt5).toBe(0);
    });

    it("a candidate with no line still satisfies a file-only expectation", () => {
        const predicted = rankedAnchors(result([], undefined, ["b.ts"]));
        expect(scoreCase([{ file: "b.ts" }], predicted).recallAt5).toBe(1);
    });
});

describe("scoreCase", () => {
    it("scores a perfect first-rank hit as 1 across the board", () => {
        const score = scoreCase([{ file: "a.ts", line: 5 }], [{ file: "a.ts", lines: [5] }]);
        expect(score).toEqual({ recallAt1: 1, recallAt5: 1, recallAt10: 1, mrr: 1, ndcg: 1 });
    });

    it("computes rank-2 metrics by hand", () => {
        const score = scoreCase(
            [{ file: "a.ts" }],
            [
                { file: "x.ts", lines: [1] },
                { file: "a.ts", lines: [1] },
            ],
        );
        expect(score.recallAt1).toBe(0);
        expect(score.recallAt5).toBe(1);
        expect(score.mrr).toBe(0.5);
        expect(score.ndcg).toBeCloseTo(1 / Math.log2(3), 10);
    });

    it("applies line tolerance, default 10", () => {
        const predicted = [{ file: "a.ts", lines: [30] }];
        expect(scoreCase([{ file: "a.ts", line: 22 }], predicted).recallAt1).toBe(1);
        expect(scoreCase([{ file: "a.ts", line: 15 }], predicted).recallAt1).toBe(0);
        expect(scoreCase([{ file: "a.ts", line: 28, tolerance: 1 }], predicted).recallAt1).toBe(0);
    });

    it("averages recall over several expected anchors", () => {
        const score = scoreCase(
            [{ file: "a.ts" }, { file: "b.ts" }, { file: "missing.ts" }],
            [
                { file: "a.ts", lines: [1] },
                { file: "b.ts", lines: [1] },
            ],
        );
        expect(score.recallAt5).toBeCloseTo(2 / 3, 10);
        expect(score.mrr).toBe(1);
    });

    it("returns zeros when nothing is found and clamps ndcg at 1", () => {
        expect(scoreCase([{ file: "a.ts" }], []).mrr).toBe(0);
        const shared = scoreCase(
            [
                { file: "a.ts", line: 1 },
                { file: "a.ts", line: 4 },
            ],
            [{ file: "a.ts", lines: [2] }],
        );
        expect(shared.ndcg).toBe(1);
    });
});
