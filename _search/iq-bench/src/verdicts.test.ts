import type { CaseRow, CaseScore } from "./schema.js";
import { verdictReport } from "./verdicts.js";

const score = (recallAt1: number, recallAt5: number, recallAt10 = recallAt5): CaseScore => ({
    recallAt1,
    recallAt5,
    recallAt10,
    mrr: recallAt1,
    ndcg: recallAt1,
    tokens: 100,
    latencyMs: 5,
});

const judged = (caseId: string, confidence: CaseRow["confidence"], caseScore?: CaseScore, config = "full"): CaseRow => {
    const row: CaseRow = { repo: "r", config, caseId, verb: "q", slices: caseScore === undefined ? ["no-answer"] : ["general"] };
    if (confidence !== undefined) {
        row.confidence = confidence;
    }
    if (caseScore !== undefined) {
        row.score = caseScore;
    }
    return row;
};

const rowOf = (table: string, verdict: string): string => table.split("\n").find((line) => line.startsWith(`| ${verdict} |`)) ?? "";

describe("verdictReport", () => {
    it("scores each verdict by how often its top answer was right", () => {
        const table = verdictReport([
            judged("a", "confident", score(1, 1)),
            judged("b", "confident", score(1, 1)),
            judged("c", "confident", score(0, 1)),
            judged("d", "ambiguous", score(0, 1)),
        ]);
        expect(rowOf(table, "confident")).toBe("| confident | 3 | 67% (2/3) | 100% (3/3) | 0 | 0% (0/3) |");
        expect(rowOf(table, "ambiguous")).toBe("| ambiguous | 1 | 0% (0/1) | 100% (1/1) | 0 | 0% (0/1) |");
    });

    it("reads weak by how often there was nothing to find: a no-answer case, or an answer not in the top 10", () => {
        const table = verdictReport([judged("a", "weak"), judged("b", "weak", score(0, 0, 0)), judged("c", "weak", score(1, 1))]);
        expect(rowOf(table, "weak")).toBe("| weak | 3 | 50% (1/2) | 50% (1/2) | 1 | 67% (2/3) |");
    });

    it("leaves out cases with no verdict and configs other than full", () => {
        const table = verdictReport([judged("a", "confident", score(1, 1)), judged("b", undefined, score(0, 0)), judged("c", "confident", score(0, 0), "no-prf")]);
        expect(rowOf(table, "confident")).toBe("| confident | 1 | 100% (1/1) | 100% (1/1) | 0 | 0% (0/1) |");
    });

    it("is empty when nothing was judged", () => {
        expect(verdictReport([judged("a", undefined, score(1, 1))])).toBe("");
    });
});

describe("the confident rule's sweep", () => {
    const scored = (caseId: string, top: number, runnerUp: number | undefined, right: boolean): CaseRow => {
        const row = judged(caseId, "ambiguous", score(right ? 1 : 0, 1));
        row.top = top;
        if (runnerUp !== undefined) {
            row.runnerUp = runnerUp;
        }
        return row;
    };

    it("reads each threshold pair's confident calls against whether their top answer was right", () => {
        const table = verdictReport([scored("a", 0.95, 0.2, true), scored("b", 0.95, 0.88, false), scored("c", 0.4, undefined, false)]);
        expect(table).toContain("The base rate, every judged case's top answer, is 33% (1/3).");
        // At 0.9 only a and b clear the floor; a lead of 0.1 keeps a alone.
        expect(rowOf(table, "0.9")).toBe("| 0.9 | 50% (1/2) | 100% (1/1) ← | 100% (1/1) | 100% (1/1) |");
        // c's runner-up never reached the cross-encoder, so its whole score is its lead.
        expect(rowOf(table, "0")).toBe("| 0 | 33% (1/3) | 50% (1/2) | 50% (1/2) | 50% (1/2) |");
    });

    it("leaves out answers an exact match judged", () => {
        const literal = scored("a", 0.95, 0.2, true);
        literal.basis = "literal";
        expect(verdictReport([literal])).not.toContain("swept");
    });
});
