/* WHAT A *SKILLED* AGENT PAYS — the number that stops this harness rewarding the wrong refactor.
 *
 * `bench.mjs` charges the naive cost: open the defining file, read it. Split a god file and that number falls
 * through the floor. But a good agent does not read whole files. It greps for the definition, reads a small
 * window around the hit, and pages forward only while the definition is still going. Against THAT policy, file
 * size barely matters — grep already dodged it — and what moves the cost is the definition getting shorter and
 * the surrounding code getting denser.
 *
 * Those two numbers pull in opposite directions and a refactor can improve one while hurting the other. In the
 * campaign this reproduces, the naive mean halved while the median skilled lookup got about 20% WORSE, because
 * stripping comments made every line denser and a fixed window costs more per line. Both were true. Reporting
 * only the first would have been a lie told with real data, which is the most durable kind.
 *
 * So this exists to be the check on the headline. If `bench` improves 60% and this improves 2%, the refactor
 * moved files around; if this improves too, the code actually got simpler.
 *
 * THE SAMPLE IS SEEDED AND RECORDED so a before/after pair can be intersected on symbol name and compared like
 * for like, rather than comparing two different random draws and calling the difference progress. */
import { mean, percentile } from "./lib/files.mjs";

const GREP_WINDOW = 60;
const PAGE_WINDOW = 2000;

// mulberry32: a tiny seeded PRNG. Determinism is the requirement — two runs of this harness on the same tree
// must draw the same sample, or the "paired" comparison is not paired.
const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const runLookupSim = (tree, countTokens, { sample = 4000, seed = 7 } = {}) => {
    // Every exported top-level symbol in the tree, in a stable order, so the draw depends on the seed and not
    // on filesystem ordering.
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

        // Call 1: grep. Charged as the matching lines it returns — cheap, but not free, and a symbol whose
        // name appears everywhere costs more here, which is a real property of a bad name.
        const hits = lines.filter((line) => line.includes(declaration.name)).length;
        let tokens = countTokens(`${path}:${declaration.startLine}:`.repeat(Math.min(hits, 40)));
        let calls = 1;

        // Call 2: read a window at the hit.
        const windowStart = Math.max(0, declaration.startLine - 1 - Math.floor(GREP_WINDOW / 4));
        tokens += countTokens(lines.slice(windowStart, windowStart + GREP_WINDOW).join("\n"));
        calls += 1;

        // Calls 3+: page forward, but only while the definition is genuinely still running. This is the term
        // that a god FUNCTION punishes and a god FILE does not.
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
        // Kept so `compare` can intersect on names and produce a genuinely paired delta.
        perSymbol,
    };
};
