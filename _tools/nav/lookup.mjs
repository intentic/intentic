// Simulates a skilled agent's read cost, grep then a window then paging forward only while the definition continues, as
// a check on bench.mjs's naive whole-file cost. The sample is seeded and recorded so a before/after pair intersects on
// symbol name, not two different random draws.
import { mean, percentile } from "./lib/files.mjs";

const GREP_WINDOW = 60;
const PAGE_WINDOW = 2000;

// mulberry32 seeded PRNG; must be deterministic so two runs on the same tree draw the same sample.
const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const runLookupSim = (tree, countTokens, { sample = 4000, seed = 7 } = {}) => {
    // Every exported top-level symbol, sorted for a stable order; the draw must depend on the seed, not file order.
    const candidates = [];
    for (const path of tree.source) {
        const file = tree.files.get(path);
        for (const declaration of file?.declarations ?? []) {
            if (declaration.exported) {
                candidates.push({ path, declaration });
            }
        }
    }
    candidates.sort((a, b) => (a.declaration.name + a.path).localeCompare(b.declaration.name + b.path));

    const random = rng(seed);
    const picked = [];
    const taken = new Set();
    const wanted = Math.min(sample, candidates.length);
    let guard = 0;
    while (picked.length < wanted && guard < wanted * 40) {
        guard += 1;
        const index = Math.floor(random() * candidates.length);
        if (taken.has(index)) {
            continue;
        }
        taken.add(index);
        picked.push(candidates[index]);
    }

    const results = [];
    const perSymbol = {};

    for (const { path, declaration } of picked) {
        const file = tree.files.get(path);
        const lines = file.text.split("\n");
        const defLines = declaration.endLine - declaration.startLine + 1;

        // Call 1: grep, charged by matching line count; a name that appears everywhere costs more here.
        const hits = lines.filter((line) => line.includes(declaration.name)).length;
        let tokens = countTokens(`${path}:${declaration.startLine}:`.repeat(Math.min(hits, 40)));
        let calls = 1;

        // Call 2: read a window at the hit.
        const windowStart = Math.max(0, declaration.startLine - 1 - Math.floor(GREP_WINDOW / 4));
        tokens += countTokens(lines.slice(windowStart, windowStart + GREP_WINDOW).join("\n"));
        calls += 1;

        // Pages forward only while the definition is still running: a god function costs here, a god file does not.
        let covered = windowStart + GREP_WINDOW;
        while (covered < declaration.endLine) {
            tokens += countTokens(lines.slice(covered, covered + PAGE_WINDOW).join("\n"));
            covered += PAGE_WINDOW;
            calls += 1;
        }

        results.push({ tokens, calls, defLines, fileLines: lines.length });
        perSymbol[declaration.name] = tokens;
    }

    const stat = (pick) => {
        const sorted = results.map(pick).sort((a, b) => a - b);
        return {
            p50: percentile(sorted, 50),
            p90: percentile(sorted, 90),
            max: sorted.at(-1) ?? 0,
            mean: Number(mean(sorted).toFixed(1)),
        };
    };

    return {
        sampled: results.length,
        seed,
        tokensReturned: stat((result) => result.tokens),
        toolCalls: { mean: Number(mean(results.map((result) => result.calls)).toFixed(3)) },
        needingExtraWindow: results.filter((result) => result.calls > 2).length,
        definitionLines: stat((result) => result.defLines),
        hostFileLines: stat((result) => result.fileLines),
        // Kept so `compare` can intersect on names for a paired delta.
        perSymbol,
    };
};
