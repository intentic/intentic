import { classOf } from "../workspace/scan.js";
import type { ImportGraph } from "./import-graph.js";

// "This changed, what else could break?" answered over the reversed import graph: start at the changed files
// and walk outward to everything that reaches them.
//
// THE DIRECTION IS DELIBERATE. Files are walked transitively; symbols are not walked here at all. Import edges
// are recorded evidence, a file said in so many words that it pulls in another, so following them several
// steps out stays defensible. A symbol-level walk has to re-scan the corpus per hop and guess a call from
// surrounding text, and the guessing compounds: by the third hop the set is mostly noise wearing a precise
// costume. The tool that inspired this walked symbols transitively and scored zero against independent ground
// truth, which is the whole reason for the split.
//
// HOP DISTANCE IS THE RANKING, and it has to be, because a shared foundation file is reached by most of the
// repo. Without an ordering and a ceiling the honest answer to "what does this affect" becomes "everything",
// which is true, useless, and expensive. What gets cut is counted and handed back rather than dropped quietly,
// a truncated set that looks complete is worse than no answer.

export interface ImpactedFile {
    readonly path: string;
    // Steps from the nearest changed file. 1 is a direct importer.
    readonly hops: number;
}

export interface ImpactResult {
    readonly reached: readonly ImpactedFile[];
    // How many reachable files the cap dropped. Never silent: a caller that shows the list shows this too.
    readonly truncated: number;
    // Seeds the index has never seen, a new file, a doc, a lockfile. Reported rather than skipped, because an
    // empty result for an unknown seed reads as "nothing is affected" when it means "I cannot tell".
    readonly unknownSeeds: readonly string[];
}

// Which way the walk runs. `importers` is "what could this break", the downstream breakage set. `imports` is
// "what does this lean on", which is a different question and, for the co-change ground truth, sometimes the
// better predictor: adding a call edits the caller AND the callee in one commit. `both` unions them.
export type ImpactDirection = "importers" | "imports" | "both";

export interface ImpactOptions {
    readonly maxHops: number;
    readonly cap: number;
    readonly direction: ImpactDirection;
}

// WHAT THE BENCHMARK CHOSE, not what seemed reasonable. Against 762 co-change cases from this repo's own
// history (`iq-bench impact`), one hop in BOTH directions beat every alternative on F1, median F1 and
// precision, and beat the no-graph folder-siblings baseline 444 wins to 168 (p < 0.001). Depth actively hurt:
// two hops of importers LOST to one hop (61 wins, 151 losses), and at two hops in both directions the walk
// reaches hundreds of files per seed and precision collapses to 0.06. Change these numbers only with a bench
// run that says so.
export const IMPACT_DEFAULTS: ImpactOptions = { maxHops: 1, cap: 40, direction: "both" };

export const impactOf = (graph: ImportGraph, seeds: readonly string[], options: ImpactOptions): ImpactResult => {
    const unknownSeeds = seeds.filter((path) => !graph.idByPath.has(path));
    const seedIds = seeds.map((path) => graph.idByPath.get(path)).filter((id): id is number => id !== undefined);
    // Seeds are the change, not its impact, so they are seen from the start and never reported as reached.
    const seen = new Set(seedIds);
    const reached: ImpactedFile[] = [];
    const neighboursOf = (id: number): number[] => [
        ...(options.direction === "imports" ? [] : (graph.importedBy.get(id) ?? [])),
        ...(options.direction === "importers" ? [] : (graph.imports.get(id) ?? [])),
    ];
    let frontier = seedIds;
    for (let hops = 1; hops <= options.maxHops && frontier.length > 0; hops++) {
        const next: number[] = [];
        for (const id of frontier) {
            for (const neighbour of neighboursOf(id)) {
                if (seen.has(neighbour)) {
                    continue;
                }
                seen.add(neighbour);
                // Breadth-first, so the first visit is the shortest distance and no later hop can improve it.
                reached.push({ path: graph.pathsById.get(neighbour)!, hops });
                next.push(neighbour);
            }
        }
        frontier = next;
    }
    const ranked = reached.toSorted((a, b) => a.hops - b.hops || (a.path < b.path ? -1 : 1));
    return {
        reached: ranked.slice(0, options.cap),
        truncated: Math.max(0, ranked.length - options.cap),
        unknownSeeds,
    };
};

// Which test files reach a changed file, and therefore stand a chance of catching a mistake in it. Coverage is
// an IMPORTERS question specifically, a test that imports the code exercises it, whereas code the test happens
// to import proves nothing, so this never runs `both`, whatever the impact walk is set to.
//
// THE DEPTH HERE IS NOT BENCHMARK-VALIDATED. The co-change gate measured which files change together, which is
// a different question from which tests exercise what; carrying its winning depth over would be borrowing
// evidence that was never collected. One hop is the conservative reading (a test that imports the file
// directly) and it will under-report coverage through re-export chains. Measuring this properly needs its own
// ground truth, mutate a file, see which suites go red, and until that exists the number stays deliberately
// timid rather than confidently wrong.
export const testsCovering = (graph: ImportGraph, seed: string, maxHops = 1): string[] =>
    impactOf(graph, [seed], { maxHops, cap: Number.MAX_SAFE_INTEGER, direction: "importers" })
        .reached.filter((file) => classOf(file.path) === "tests")
        .map((file) => file.path);
