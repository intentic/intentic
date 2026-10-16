// The before → after rows of two measurements, as data, so `run.mjs compare` prints them and `trend.mjs summary`
// renders them as markdown from one list.

export const n = (value) => (typeof value === "number" ? value.toLocaleString("en-US") : String(value));

export const pct = (before, after) => {
    if (!before) {
        return "—";
    }
    const delta = ((after - before) / before) * 100;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${delta.toFixed(1)}%`;
};

// `score` rows are better when they fall; `cost` rows are a price, not a score, since module count and import edges
// rising is the cost of a decomposition, not a win or a loss.
const score = (label, before, after) => ({ label, before, after, kind: "score" });
const cost = (label, before, after) => ({ label, before, after, kind: "cost" });

// What share of a line reduction was comments and blanks rather than code; undefined unless lines fell.
const sizeNote = (before, after) => {
    const physicalDrop = before.shape.lines.physical - after.shape.lines.physical;
    const codeDrop = before.shape.lines.code - after.shape.lines.code;
    if (physicalDrop <= 0) {
        return undefined;
    }
    const share = ((physicalDrop - codeDrop) / physicalDrop) * 100;
    return `${share.toFixed(0)}% of the line reduction was comments and blanks, not code.`;
};

// Only symbols present in both samples, compared to themselves; two independent random draws differ enough on their own
// to manufacture a result.
const pairedNote = (before, after) => {
    const shared = Object.keys(before.lookup.perSymbol).filter((name) => name in after.lookup.perSymbol);
    if (shared.length < 50) {
        return `only ${shared.length} symbols in both samples; paired delta omitted as unreliable.`;
    }
    const b = shared.reduce((total, name) => total + before.lookup.perSymbol[name], 0) / shared.length;
    const a = shared.reduce((total, name) => total + after.lookup.perSymbol[name], 0) / shared.length;
    return `paired on ${n(shared.length)} symbols present in both: ${b.toFixed(0)} → ${a.toFixed(0)} tokens (${pct(b, a)})`;
};

/** The sections of a comparison, each `{ title, rows, notes }`; the caller has already refused mixed tokenizers. */
export const compareRows = (before, after) => [
    {
        title: "SIZE (read all three rows or none)",
        rows: [
            score("physical lines", before.shape.lines.physical, after.shape.lines.physical),
            score("code lines", before.shape.lines.code, after.shape.lines.code),
            score("comment + blank lines", before.shape.lines.commentAndBlank, after.shape.lines.commentAndBlank),
            cost("test lines", before.shape.files.testLines, after.shape.files.testLines),
        ],
        notes: [sizeNote(before, after)].filter((note) => note !== undefined),
    },
    {
        title: "AGENT COST",
        rows: [
            score("naive: defining file tokens (p50)", before.bench.fileTokens.p50, after.bench.fileTokens.p50),
            score("naive: defining file tokens (p90)", before.bench.fileTokens.p90, after.bench.fileTokens.p90),
            score("naive: lookups over 128k tokens", before.bench.over128k, after.bench.over128k),
            score("naive: total tokens if read whole", before.bench.totalTokensIfReadWhole, after.bench.totalTokensIfReadWhole),
            score("skilled: tokens returned (mean)", before.lookup.tokensReturned.mean, after.lookup.tokensReturned.mean),
            score("skilled: tokens returned (p50)", before.lookup.tokensReturned.p50, after.lookup.tokensReturned.p50),
        ],
        notes: [pairedNote(before, after)],
    },
    {
        title: "SHAPE",
        rows: [
            score("files over 2000 lines", before.shape.fileSize.over2000, after.shape.fileSize.over2000),
            score("functions over 100 lines", before.shape.functions.over100, after.shape.functions.over100),
            score("worst complexity", before.shape.complexity.max, after.shape.complexity.max),
            score("longest if/else-if chain", before.shape.controlFlow.longestIfChain, after.shape.controlFlow.longestIfChain),
        ],
        notes: [],
    },
    {
        title: "WHAT IT COST — these are SUPPOSED to get worse; the question is how much",
        rows: [
            cost("modules", before.shape.cost.modules, after.shape.cost.modules),
            cost("import edges", before.shape.cost.importEdges, after.shape.cost.importEdges),
            cost("mean fan-out", before.shape.cost.meanFanOut, after.shape.cost.meanFanOut),
            cost("largest import cycle", before.shape.cost.largestCycle, after.shape.cost.largestCycle),
        ],
        notes: [],
    },
];

// ✓ a score that fell, ✗ one that rose, blank one that held, · a cost whichever way it moved.
export const glyphOf = ({ kind, before, after }) => {
    if (kind === "cost") {
        return "·";
    }
    const moved = after - before;
    return moved === 0 ? " " : moved < 0 ? "✓" : "✗";
};
