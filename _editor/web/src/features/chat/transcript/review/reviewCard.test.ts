import { WORKSPACE_ROOT } from "@intentic/constants";
import type { ReviewFindings } from "@intentic/sandbox-contract/events/review";
import { findingChips, findingPlace, findingsLabel, fixRequest, openFindings, reviewerLabel, summaryParts } from "./reviewCard";

// path-literals: content, the files a review's findings name as the card shows them
const REVIEW: ReviewFindings = {
    id: `review-1`,
    source: `claude`,
    level: `high`,
    findings: [
        { file: `src/parse.ts`, line: 12, summary: `Off-by-one drops the last token.`, verdict: `CONFIRMED` },
        { file: `${WORKSPACE_ROOT}/repo/src/upload.ts`, line: 40, endLine: 44, summary: `Retry drops the last chunk`, priority: 1 },
        { file: `src/cache.ts`, summary: `The cache never expires.`, verdict: `PLAUSIBLE`, outcome: `fixed` },
    ],
};

describe(`the review card's words`, () => {
    it(`says who reviewed and how much it found, or that it found nothing`, () => {
        expect(reviewerLabel(REVIEW)).toBe(`Claude Code`);
        expect(reviewerLabel({ ...REVIEW, source: `codex` })).toBe(`Codex`);
        expect(findingsLabel(REVIEW)).toBe(`3 findings`);
        expect(findingsLabel({ ...REVIEW, findings: REVIEW.findings.slice(0, 1) })).toBe(`1 finding`);
        expect(findingsLabel({ ...REVIEW, findings: [] })).toBe(`No findings`);
    });

    it(`names a place by its file and line on the row, and in full for the hover`, () => {
        expect(findingPlace(REVIEW.findings[0]!)).toEqual({ short: `parse.ts:12`, full: `src/parse.ts:12` });
        expect(findingPlace(REVIEW.findings[1]!)).toEqual({ short: `upload.ts:40-44`, full: `${WORKSPACE_ROOT}/repo/src/upload.ts:40-44` });
        expect(findingPlace(REVIEW.findings[2]!)).toEqual({ short: `cache.ts`, full: `src/cache.ts` });
    });

    // What happened to it leads once fixes ran; then urgency, then whether a pass confirmed it.
    it(`chips a finding by its outcome, its urgency and its verdict`, () => {
        expect(findingChips(REVIEW.findings[0]!)).toEqual([{ label: `confirmed`, tone: `warning` }]);
        expect(findingChips(REVIEW.findings[1]!)).toEqual([{ label: `P1`, tone: `danger` }]);
        // Once fixes ran, the outcome is all that is left to say.
        expect(findingChips(REVIEW.findings[2]!)).toEqual([{ label: `fixed`, tone: `success` }]);
    });

    // The model writes names in backticks; the card draws them as code, as text, never as markup.
    it(`draws a sentence's backticked names as code, and leaves an unmatched backtick as one`, () => {
        expect(summaryParts(`The \`cache\` never expires.`)).toEqual([
            { text: `The `, code: false },
            { text: `cache`, code: true },
            { text: ` never expires.`, code: false },
        ]);
        expect(summaryParts(`\`a\` and \`b`)).toEqual([
            { text: `a`, code: true },
            { text: ` and \`b`, code: false },
        ]);
        expect(summaryParts(`<b>plain</b>`)).toEqual([{ text: `<b>plain</b>`, code: false }]);
    });

    it(`asks for the findings still open, named as the review named them`, () => {
        const open = openFindings(REVIEW);
        expect(open).toHaveLength(2);
        expect(fixRequest(open)).toBe(
            `Fix these findings from the review above:\n1. src/parse.ts:12 — Off-by-one drops the last token.\n2. ${WORKSPACE_ROOT}/repo/src/upload.ts:40-44 — Retry drops the last chunk`,
        );
        expect(fixRequest([REVIEW.findings[0]!])).toBe(`Fix this finding from the review above: src/parse.ts:12 — Off-by-one drops the last token.`);
    });
});
