import type { AgentEvent } from "../events/agent-events.js";
import type { Page } from "../events/requests.js";
import type { ReviewFindings } from "../events/review.js";
import { foldTurn, userRow } from "./transcript-fold.js";

// path-literals: content, a page's stored path and a finding's file as transcript rows carry them
const PAGE: Page = { id: "p1", title: "Q3 revenue", path: ".intentic/records/artifacts/pages/c1/p1.r0.html" };
const REVIEW: ReviewFindings = {
    id: "review-1",
    source: "claude",
    level: "high",
    findings: [{ file: "src/parse.ts", line: 12, summary: "Off-by-one drops the last token.", verdict: "CONFIRMED" }],
};

const fold = (events: readonly AgentEvent[]) => foldTurn([userRow("/code-review high", 1, [])], events).slice(1);

describe("a review in the fold", () => {
    it("draws the findings on the bubble that reported them, and starts the next words below", () => {
        const rows = fold([
            { kind: "tool_call", id: "t1", name: "ReportFindings", category: "other", status: "in_progress" },
            { kind: "review", review: REVIEW },
            { kind: "delta", text: "One finding." },
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0]?.review).toEqual(REVIEW);
        expect(rows[1]).toEqual({ role: "assistant", text: "One finding." });
    });

    // The skill re-reports the same findings once it has fixed them: the card is redrawn, not drawn twice.
    it("folds the earlier card away when the same review is re-reported with its outcomes", () => {
        const fixed: ReviewFindings = { ...REVIEW, findings: REVIEW.findings.map((finding) => ({ ...finding, outcome: "fixed" as const })) };
        const rows = fold([{ kind: "review", review: REVIEW }, { kind: "delta", text: "Fixing." }, { kind: "text_end" }, { kind: "review", review: fixed }]);
        expect(rows[0]?.review?.superseded).toBe(true);
        expect(rows.at(-1)?.review).toEqual(fixed);
    });

    // A page and a review share the redraw rule by id, never each other's rows.
    it("keeps a page and a review that share an id apart", () => {
        const rows = fold([{ kind: "page", page: PAGE }, { kind: "review", review: { ...REVIEW, id: PAGE.id } }]);
        expect(rows[0]?.page?.superseded).toBeUndefined();
        expect(rows[1]?.review?.id).toBe(PAGE.id);
    });
});
