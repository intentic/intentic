import type { Budget } from "../baseline.js";

// Two scenarios over the same input, the second through a cache or an incremental path: their ratio is the claim, and a
// ratio moves little with the CPU, the Node patch or the input's exact size, where a raw instruction count moves with all
// three.
const ratio = (numerator: string, denominator: string): Budget["value"] => (measured) =>
    measured[numerator]!["instructions"]! / measured[denominator]!["instructions"]!;

/** What the instruction counts may not exceed. Everything else they measure is a report against baselines/instr.json. */
export const INSTR_BUDGETS: readonly Budget[] = [
    {
        name: "ignore-rewalk / ignore-walk",
        // Recorded at 7.2%: a repeat walk answers from the compiled matchers and the per-path cache. Ten percent fails
        // when a repeat walk starts recompiling or re-matching, which costs the walk again.
        claim: "a repeat workspace walk answers its ignore checks from the cache, at a tenth of the first walk or less",
        reads: ["ignore-rewalk", "ignore-walk"],
        value: ratio("ignore-rewalk", "ignore-walk"),
        max: 0.1,
    },
    {
        name: "fuzzy-typing / fuzzy-rank",
        // The same 20 keystrokes over the same 20,000 paths, through the ranker quick-open keeps (43% at recording) and
        // re-ranked from scratch. Sixty percent fails when a keystroke goes back to scoring every path.
        claim: "quick-open's ranker scores only what the previous keystroke matched, so typing costs well under re-ranking every path",
        reads: ["fuzzy-typing", "fuzzy-rank"],
        value: ratio("fuzzy-typing", "fuzzy-rank"),
        max: 0.6,
    },
];
