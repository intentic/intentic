import { CONFIDENCE_MARGIN, CONFIDENT_FLOOR } from "@intentic/iq-engine";
import type { CaseRow } from "./schema.js";

// The verdict table: for each word iq's answer line printed, how often the top answer was the expected one. A verdict
// earns its place in the capsule only by predicting that. "confident" tells the reader to stop searching, so it should
// be right most of the time; "weak" tells them the thing may not exist, so its cases should mostly be no-answer ones or
// answers iq did not find anyway. The 2026-10 transcript mining found the old words carried no such signal: agents ran
// rg within five calls about as often after "confident" as after "ambiguous".

const VERDICTS = ["confident", "ambiguous", "weak"] as const;

const share = (count: number, total: number): string => (total === 0 ? "—" : `${Math.round((count / total) * 100)}% (${count}/${total})`);

// Right means the top-ranked unit holds an expected anchor; recall@1 is the fraction of expected anchors there, so any
// share of it counts.
const topRight = (row: CaseRow): boolean => (row.score?.recallAt1 ?? 0) > 0;
const inTop5 = (row: CaseRow): boolean => (row.score?.recallAt5 ?? 0) > 0;
const missed = (row: CaseRow): boolean => (row.score?.recallAt10 ?? 0) === 0;

const verdictLine = (verdict: string, rows: readonly CaseRow[]): string => {
    const answerable = rows.filter((row) => row.score !== undefined);
    const noAnswer = rows.filter((row) => row.score === undefined && row.slices.includes("no-answer"));
    // For "weak" the useful reading is how often the call was justified: nothing to find, or nothing found.
    const justified = noAnswer.length + answerable.filter(missed).length;
    return `| ${verdict} | ${rows.length} | ${share(answerable.filter(topRight).length, answerable.length)} | ${share(answerable.filter(inTop5).length, answerable.length)} | ${noAnswer.length} | ${share(justified, rows.length)} |`;
};

// ---- the confident rule, swept ----

// Candidate thresholds for the top file's cross-encoder probability and its lead over the runner-up's.
const FLOORS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const MARGINS = [0.05, 0.1, 0.2, 0.3];

// The cases a rerank judged, with the two scores the rule reads: an exact answer (literal, route, defined name) is
// judged by its match and never reaches this rule.
const reranked = (rows: readonly CaseRow[]): CaseRow[] =>
    rows.filter((row) => row.score !== undefined && row.top !== undefined && (row.basis === undefined || row.basis === "rerank"));

// What each (floor, lead) pair would call confident among the judged answerable cases, and how often that top answer
// was right: the table the rule's thresholds are read off. The lead over a runner-up the cross-encoder never scored
// counts as the widest, as the engine counts it.
const sweepLines = (rows: readonly CaseRow[]): string[] => {
    const judged = reranked(rows);
    if (judged.length === 0) {
        return [];
    }
    const lines = [
        "\n### The confident rule, swept on `full`\n",
        `Reranked answerable cases (${judged.length}): how many each threshold pair calls confident, and how often its top answer was right. ` +
            `The base rate, every judged case's top answer, is ${share(judged.filter(topRight).length, judged.length)}.\n`,
        `| top ≥ | ${MARGINS.map((margin) => `lead ≥ ${margin}`).join(" | ")} |`,
        `|---:|${MARGINS.map(() => "---:").join("|")}|`,
    ];
    for (const floor of FLOORS) {
        const cells = MARGINS.map((margin) => {
            const confident = judged.filter((row) => row.top! >= floor && row.top! - (row.runnerUp ?? 0) >= margin);
            const mark = floor === CONFIDENT_FLOOR && margin === CONFIDENCE_MARGIN ? " ←" : "";
            return `${share(confident.filter(topRight).length, confident.length)}${mark}`;
        });
        lines.push(`| ${floor} | ${cells.join(" | ")} |`);
    }
    return lines;
};

// One table for `full`, the configuration the thresholds are calibrated on. Cases with no verdict (exact verbs, which
// never reach the cross-encoder) are left out, so the rows add up to the judged cases only.
export const verdictReport = (rows: readonly CaseRow[]): string => {
    const full = rows.filter((row) => row.config === "full" && row.skipped === undefined && row.confidence !== undefined);
    if (full.length === 0) {
        return "";
    }
    return [
        "\n## Verdicts on `full`\n",
        "For each word the answer line printed: how often the top answer held an expected anchor, how often one was in the top 5, " +
            "and how many no-answer cases drew it. `nothing to find` counts no-answer cases plus answerable ones whose answer was not in the " +
            "top 10 either: the cases where telling the reader to stop was right.\n",
        "| verdict | cases | top answer right | in top 5 | no-answer | nothing to find |",
        "|---|---:|---:|---:|---:|---:|",
        ...VERDICTS.flatMap((verdict) => {
            const judged = full.filter((row) => row.confidence === verdict);
            return judged.length === 0 ? [] : [verdictLine(verdict, judged)];
        }),
        ...sweepLines(rows.filter((row) => row.config === "full" && row.skipped === undefined)),
    ].join("\n");
};
