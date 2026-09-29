import { WEAK_FLOOR } from "@intentic/iq-engine";
import { CONFIGS } from "./configs.js";
import { type CaseRow, type Slice, SLICES } from "./schema.js";

// The per-slice view of a retrieval run and the calibration of iq's weak floor. One average over every case hides a
// regression in a slice of eight, so each slice is reported on its own, with its size beside its percentage.

const SLICE_ORDER: readonly Slice[] = ["general", ...SLICES];

const percent = (value: number): string => `${Math.round(value * 100)}`;

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const ranConfigs = (rows: readonly CaseRow[]): string[] =>
    CONFIGS.map((config) => config.name).filter((name) => rows.some((row) => row.config === name && row.skipped === undefined));

// No-answer cases are scored on their own row by `weak`; every other row scores its answerable cases by retrieval.
const inSlice = (rows: readonly CaseRow[], slice: Slice): CaseRow[] =>
    rows.filter((row) => row.slices.includes(slice) && (slice === "no-answer" ? row.score === undefined : row.score !== undefined));

interface SliceCell {
    readonly text: string;
    readonly perfect: boolean;
}

const sliceCell = (rows: readonly CaseRow[], slice: Slice): SliceCell | undefined => {
    if (rows.length === 0) {
        return undefined;
    }
    if (slice === "no-answer") {
        const weak = rows.filter((row) => row.weak === true).length;
        return { text: percent(weak / rows.length), perfect: weak === rows.length };
    }
    const scores = rows.flatMap((row) => (row.score === undefined ? [] : [row.score]));
    const at1 = mean(scores.map((score) => score.recallAt1));
    const at5 = mean(scores.map((score) => score.recallAt5));
    // recall@1 at 100% puts every expected anchor first, so every other metric is perfect too.
    return { text: `${percent(at1)} · ${percent(at5)}`, perfect: at1 === 1 };
};

const caseCount = (rows: readonly CaseRow[]): number => new Set(rows.map((row) => `${row.repo}/${row.caseId}`)).size;

// Rows are slices, columns configs. A slice every config scores perfectly on can no longer show a change, whichever
// stage is switched off: it is flagged rather than read as good news.
export const sliceTable = (rows: readonly CaseRow[]): string => {
    const configs = ranConfigs(rows);
    if (configs.length === 0) {
        return "";
    }
    const lines = [
        "\n## By slice\n",
        "Answerable slices: recall@1 · recall@5, in percent. `no-answer`: the percent of cases where iq said its match was weak (or found nothing). " +
            "A case may sit in several slices; `general` is every case tagged with none. Read a percentage with its case count.\n",
        `| slice | cases | ${configs.join(" | ")} | |`,
        `|---|---:|${configs.map(() => "---:").join("|")}|---|`,
    ];
    for (const slice of SLICE_ORDER) {
        const sliceRows = inSlice(rows, slice);
        if (sliceRows.length === 0) {
            continue;
        }
        const cells = configs.map((config) =>
            sliceCell(
                sliceRows.filter((row) => row.config === config && row.skipped === undefined),
                slice,
            ),
        );
        const saturated = cells.every((cell) => cell === undefined || cell.perfect) && cells.some((cell) => cell !== undefined);
        const flag = saturated ? `**saturated**: every config run scores 100%, so this slice can no longer show a change` : "";
        lines.push(`| ${slice} | ${caseCount(sliceRows)} | ${cells.map((cell) => cell?.text ?? "—").join(" | ")} | ${flag} |`);
    }
    return lines.join("\n");
};

// ---- weak floor ----

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

// Four places: the no-answer cases and the worst answerable ones sit below 0.01, where three would print zeros.
const fmtScore = (value: number): string => value.toFixed(4);

const distributionLine = (label: string, values: readonly number[]): string => {
    if (values.length === 0) {
        return `| ${label} | 0 | | | | | | |`;
    }
    const sorted = values.toSorted((a, b) => a - b);
    const cells = [0, 0.1, 0.25, 0.5, 0.75].map((q) => fmtScore(quantile(sorted, q)));
    return `| ${label} | ${values.length} | ${cells.join(" | ")} | ${fmtScore(sorted.at(-1) ?? 0)} |`;
};

// Log-spaced: both populations spread over orders of magnitude, and the floor sits in the lowest of them.
const SWEEP = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

const share = (count: number, total: number): string => (total === 0 ? "—" : `${percent(count / total)}% (${count}/${total})`);

// Which answerable cases the floor can misjudge: only those a rerank judged. An exact verb (def, refs, find …) never
// reaches the cross-encoder, so counting it would dilute the false-weak rate with cases that cannot fail it.
const judged = (rows: readonly CaseRow[]): CaseRow[] => rows.filter((row) => row.score !== undefined && row.relevance !== undefined);
const noAnswer = (rows: readonly CaseRow[]): CaseRow[] => rows.filter((row) => row.slices.includes("no-answer") && row.skipped === undefined);

const perConfigLine = (config: string, rows: readonly CaseRow[]): string => {
    const answerable = judged(rows);
    const falseWeak = answerable.filter((row) => row.weak === true);
    // A false alarm on a case iq missed anyway is honest about what it showed; one on a found answer costs the reader.
    const missed = falseWeak.filter((row) => (row.score?.recallAt10 ?? 0) === 0).length;
    const unanswerable = noAnswer(rows);
    const caught = unanswerable.filter((row) => row.weak === true).length;
    return `| ${config} | ${share(caught, unanswerable.length)} | ${share(falseWeak.length, answerable.length)} | ${missed} |`;
};

// The floor is calibrated on `full`: the relevance distributions of the two populations, then what each candidate floor
// would have cost (answerable cases called weak) and caught (no-answer cases called weak).
const calibration = (rows: readonly CaseRow[]): string[] => {
    const answerable = judged(rows).flatMap((row) => (row.relevance === undefined ? [] : [row.relevance]));
    const found = judged(rows).flatMap((row) => (row.relevance === undefined || row.score?.recallAt1 !== 1 ? [] : [row.relevance]));
    const unanswerable = noAnswer(rows).flatMap((row) => (row.relevance === undefined ? [] : [row.relevance]));
    if (answerable.length === 0 && unanswerable.length === 0) {
        return [];
    }
    const lines = [
        "\n### Calibration on `full`: best cross-encoder probability per case\n",
        "| cases | n | min | p10 | p25 | median | p75 | max |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
        distributionLine("answerable, reranked", answerable),
        distributionLine("answerable, found at rank 1", found),
        distributionLine("no-answer", unanswerable),
        "\n| floor | answerable called weak | no-answer called weak |",
        "|---:|---:|---:|",
    ];
    for (const floor of [...new Set([...SWEEP, WEAK_FLOOR])].toSorted((a, b) => a - b)) {
        const falseWeak = answerable.filter((value) => value < floor).length;
        const caught = unanswerable.filter((value) => value < floor).length;
        const mark = floor === WEAK_FLOOR ? " ← WEAK_FLOOR" : "";
        lines.push(`| ${floor}${mark} | ${share(falseWeak, answerable.length)} | ${share(caught, unanswerable.length)} |`);
    }
    return lines;
};

// Only configs with a cross-encoder can say "weak"; the others appear with their zero so that loss is visible.
export const weakReport = (rows: readonly CaseRow[]): string => {
    const configs = ranConfigs(rows);
    if (noAnswer(rows).length === 0 && !rows.some((row) => row.relevance !== undefined)) {
        return "";
    }
    const lines = [
        "\n## Weak answers\n",
        `iq calls an answer weak when no reranked passage reaches a cross-encoder probability of ${WEAK_FLOOR} (\`WEAK_FLOOR\`). ` +
            "A no-answer case is right when it is called weak; an answerable one called weak is a false alarm, counted over the " +
            "cases a rerank judged. `missed` counts the false alarms on cases whose answer was not in the top 10 anyway.\n",
        "| config | no-answer called weak | answerable called weak | missed |",
        "|---|---:|---:|---:|",
        ...configs.map((config) =>
            perConfigLine(
                config,
                rows.filter((row) => row.config === config),
            ),
        ),
        ...calibration(rows.filter((row) => row.config === "full")),
    ];
    return lines.join("\n");
};
