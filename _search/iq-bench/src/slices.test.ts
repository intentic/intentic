import { WEAK_FLOOR } from "@intentic/iq-engine";
import type { CaseRow, CaseScore } from "./schema.js";
import { sliceTable, weakReport } from "./slices.js";

const score = (recallAt1: number, recallAt5: number, recallAt10 = recallAt5): CaseScore => ({
    recallAt1,
    recallAt5,
    recallAt10,
    mrr: recallAt1,
    ndcg: recallAt1,
    tokens: 100,
    latencyMs: 5,
});

// A row as retrieval.ts writes it: `relevance` only when a rerank ran, and then `weak` read off the floor.
const answerable = (config: string, caseId: string, slices: CaseRow["slices"], caseScore: CaseScore, relevance?: number): CaseRow => {
    const row: CaseRow = { repo: "r", config, caseId, verb: "q", slices, score: caseScore, weak: false };
    if (relevance !== undefined) {
        row.relevance = relevance;
        row.weak = relevance < WEAK_FLOOR;
    }
    return row;
};

const unanswerable = (config: string, caseId: string, weak: boolean, relevance?: number): CaseRow => {
    const row: CaseRow = { repo: "r", config, caseId, verb: "q", slices: ["no-answer"], weak };
    if (relevance !== undefined) {
        row.relevance = relevance;
    }
    return row;
};

const rowOf = (table: string, slice: string): string => table.split("\n").find((line) => line.startsWith(`| ${slice} |`)) ?? "";

describe("sliceTable", () => {
    it("reports each slice's case count beside recall@1 · recall@5 per config", () => {
        const rows = [
            answerable("full", "a", ["general"], score(1, 1)),
            answerable("full", "b", ["general"], score(0, 1)),
            answerable("no-rerank", "a", ["general"], score(0, 0)),
            answerable("no-rerank", "b", ["general"], score(0, 1)),
        ];
        expect(rowOf(sliceTable(rows), "general")).toBe("| general | 2 | 50 · 100 | 0 · 50 |  |");
    });

    it("counts a case in every slice it carries", () => {
        const rows = [
            answerable("full", "a", ["identifier-in-prose", "near-duplicate"], score(1, 1)),
            answerable("full", "b", ["near-duplicate"], score(0, 0)),
        ];
        const table = sliceTable(rows);
        expect(rowOf(table, "identifier-in-prose")).toMatch(/^\| identifier-in-prose \| 1 \| 100 · 100 \|/);
        expect(rowOf(table, "near-duplicate")).toMatch(/^\| near-duplicate \| 2 \| 50 · 50 \|/);
    });

    it("flags a slice every config scores 100% on as saturated", () => {
        const rows = [answerable("full", "a", ["paraphrase"], score(1, 1)), answerable("no-rerank", "a", ["paraphrase"], score(1, 1))];
        expect(rowOf(sliceTable(rows), "paraphrase")).toContain("**saturated**");
    });

    it("does not flag a slice one config still misses at rank 1, though every config reaches the top 5", () => {
        const rows = [answerable("full", "a", ["paraphrase"], score(1, 1)), answerable("no-rerank", "a", ["paraphrase"], score(0, 1))];
        expect(rowOf(sliceTable(rows), "paraphrase")).not.toContain("saturated");
    });

    it("scores the no-answer slice by the share of cases called weak", () => {
        const rows = [
            unanswerable("full", "x", true),
            unanswerable("full", "y", false),
            unanswerable("full", "z", true),
            unanswerable("full", "w", true),
        ];
        expect(rowOf(sliceTable(rows), "no-answer")).toBe("| no-answer | 4 | 75 |  |");
    });
});

describe("weakReport", () => {
    it("counts false alarms over the reranked answerable cases only, and separates the ones iq missed anyway", () => {
        const rows = [
            answerable("full", "found-weak", ["general"], score(1, 1), WEAK_FLOOR / 2),
            answerable("full", "missed-weak", ["general"], score(0, 0, 0), WEAK_FLOOR / 2),
            answerable("full", "found", ["general"], score(1, 1), 0.9),
            // An exact verb never reaches the cross-encoder, so it cannot be a false alarm and does not dilute the rate.
            answerable("full", "exact", ["general"], score(1, 1)),
            unanswerable("full", "x", true, WEAK_FLOOR / 2),
            unanswerable("full", "y", false, 0.8),
        ];
        const line = weakReport(rows)
            .split("\n")
            .find((row) => row.startsWith("| full |"));
        expect(line).toBe("| full | 50% (1/2) | 67% (2/3) | 1 |");
    });

    it("marks the shipped floor on the calibration sweep", () => {
        const rows = [answerable("full", "a", ["general"], score(1, 1), 0.9), unanswerable("full", "x", true, 0.001)];
        const sweep = weakReport(rows)
            .split("\n")
            .find((row) => row.includes("← WEAK_FLOOR"));
        expect(sweep).toBe(`| ${WEAK_FLOOR} ← WEAK_FLOOR | 0% (0/1) | 100% (1/1) |`);
    });

    it("says nothing when no case was reranked and none is a no-answer case", () => {
        expect(weakReport([answerable("bm25-only", "a", ["general"], score(1, 1))])).toBe("");
    });
});
