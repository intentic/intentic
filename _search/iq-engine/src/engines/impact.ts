import { classOf } from "../workspace/scan.js";
import type { ImportGraph } from "./import-graph.js";

// Walks the reversed import graph outward from changed files, files only: import edges are evidence, a symbol walk
// would have to guess. Hop distance is the ranking; a shared foundation file would otherwise reach most of the repo.

export interface ImpactedFile {
    readonly path: string;
    // Steps from the nearest changed file; 1 is a direct importer.
    readonly hops: number;
}

export interface ImpactResult {
    readonly reached: readonly ImpactedFile[];
    // How many reachable files the cap dropped; never silent, a caller that shows the list shows this too.
    readonly truncated: number;
    // Seeds the index has never seen; reported, not skipped, so it does not read as "nothing affected".
    readonly unknownSeeds: readonly string[];
}

// Which way the walk runs: `importers` is what could break (downstream), `imports` is what this leans on (upstream),
// `both` unions them.
export type ImpactDirection = "importers" | "imports" | "both";

export interface ImpactOptions {
    readonly maxHops: number;
    readonly cap: number;
    readonly direction: ImpactDirection;
}

// Chosen by `iq-bench impact` benchmarking, not intuition; change only with a new bench run to confirm it.
export const IMPACT_DEFAULTS: ImpactOptions = { maxHops: 1, cap: 40, direction: "both" };

export const impactOf = (graph: ImportGraph, seeds: readonly string[], options: ImpactOptions): ImpactResult => {
    const unknownSeeds = seeds.filter((path) => !graph.idByPath.has(path));
    const seedIds = seeds.map((path) => graph.idByPath.get(path)).filter((id): id is number => id !== undefined);
    // Seeds are the change, not its impact; seen from the start so they are never reported as reached.
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

// Which tests reach a changed file: always `importers`, a test importing code exercises it, not the reverse. Depth is a
// conservative guess, not benchmark-validated; it under-reports through re-export chains.
export const testsCovering = (graph: ImportGraph, seed: string, maxHops = 1): string[] =>
    impactOf(graph, [seed], { maxHops, cap: Number.MAX_SAFE_INTEGER, direction: "importers" })
        .reached.filter((file) => classOf(file.path) === "tests")
        .map((file) => file.path);
