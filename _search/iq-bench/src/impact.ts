import { execFileSync } from "node:child_process";
import { type ImpactDirection, type ImpactedFile, type ImpactResult, type ImportGraph, impactOf, loadImportGraph } from "@intentic/iq-engine";
import { ensureIndex, indexDirFor, repoRoot } from "./repos.js";

// Tier 1b — does impact analysis actually predict what a change touches?
//
// THE GROUND TRUTH IS GIT, NOT THE GRAPH. Show the predictor ONE file from a past commit and ask which other
// files that commit touched. The author already answered; we only check. This is the test the tool that
// inspired the feature could not pass — its published recall of 1.0 was measured against a set derived from
// the same graph doing the predicting, which cannot fail by construction and therefore proves nothing.
//
// TWO BASELINES, BOTH OF WHICH MUST BE BEATEN. `same-dir` uses no graph at all: it names the seed's folder
// siblings. Co-change is strongly local, so this is a genuinely hard bar and the honest thing to publish next
// to a graph result. `hops-1` is the reach we already have today via the related line — if the transitive walk
// does not beat one hop, the walk is not worth its cost and this feature does not ship.
//
// WHAT THIS DOES NOT MEASURE: co-change is a proxy. Two files edited together are usually related, but authors
// also batch unrelated work into one commit, and a genuinely affected file that needed no edit is scored as a
// false positive. Both push measured precision DOWN, so a strategy that scores well here is not flattered by
// the metric. Read recall as the real signal and precision as a loose upper bound on noise.

const HISTORY = 400;
// Large commits would otherwise dominate the case count and quietly turn this into a benchmark about sweeping
// mechanical edits, which is the one shape a co-change proxy is least honest about.
const SEEDS_PER_COMMIT = 3;

const CODE = /\.(ts|tsx|mts|js|jsx|mjs|vue|py|go|rs|java)$/;

export interface ImpactStrategy {
    readonly name: string;
    // 0 means the graph is not consulted at all — the folder-siblings baseline.
    readonly maxHops: number;
    readonly cap: number;
    readonly direction: ImpactDirection;
    // Union the graph's answer with the seed's folder siblings. The two turned out to find different things,
    // and a combination that beats both separately is a real result rather than a tie-break.
    readonly withSiblings?: boolean;
}

// The two bars a graph strategy has to clear. `same-dir` consults no graph; `importers-1` is the reach the
// related line already gives us today, so anything that does not beat it is not worth building.
export const IMPACT_BASELINES = ["same-dir", "importers-1"] as const;

export const IMPACT_STRATEGIES: readonly ImpactStrategy[] = [
    { name: "same-dir", maxHops: 0, cap: 50, direction: "importers" },
    { name: "importers-1", maxHops: 1, cap: 50, direction: "importers" },
    { name: "importers-2", maxHops: 2, cap: 50, direction: "importers" },
    { name: "importers-3", maxHops: 3, cap: 50, direction: "importers" },
    { name: "imports-1", maxHops: 1, cap: 50, direction: "imports" },
    { name: "both-1", maxHops: 1, cap: 50, direction: "both" },
    { name: "both-2", maxHops: 2, cap: 50, direction: "both" },
    { name: "both-1+dir", maxHops: 1, cap: 50, direction: "both", withSiblings: true },
    { name: "both-2+dir", maxHops: 2, cap: 50, direction: "both", withSiblings: true },
];

export interface ImpactCase {
    readonly sha: string;
    readonly seed: string;
    readonly truth: readonly string[];
}

export interface ImpactRow {
    readonly strategy: string;
    readonly sha: string;
    readonly seed: string;
    readonly truthCount: number;
    readonly predictedCount: number;
    readonly truePositives: number;
    readonly precision: number;
    readonly recall: number;
    readonly f1: number;
    readonly truncated: number;
}

export interface ImpactMeta {
    readonly repo: string;
    readonly commitsScanned: number;
    readonly commitsUsable: number;
    // A commit whose code files the current index does not know — renamed, deleted, or moved since. The graph
    // describes the working tree, so these cannot be graded soundly either way.
    readonly droppedNotIndexed: number;
    readonly droppedTooSmall: number;
    readonly cases: number;
    readonly graphFiles: number;
    readonly graphEdges: number;
    // External repos are cloned at `--depth 1`, so there is no history to mine and every aggregate would be
    // computed over nothing. That has to be shouted, not inferred from a small case count.
    readonly shallow: boolean;
}

const git = (root: string, args: readonly string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export const buildImpactCases = (
    root: string,
    graph: ImportGraph,
): { cases: ImpactCase[]; commitsScanned: number; commitsUsable: number; droppedNotIndexed: number; droppedTooSmall: number } => {
    const shas = git(root, ["log", "--format=%H", "-n", String(HISTORY)])
        .split("\n")
        .filter((line) => line !== "");
    const cases: ImpactCase[] = [];
    let commitsUsable = 0;
    let droppedNotIndexed = 0;
    let droppedTooSmall = 0;
    for (const sha of shas) {
        const touched = git(root, ["show", "--name-only", "--format=", "--no-renames", sha])
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && CODE.test(line));
        if (touched.length < 2) {
            droppedTooSmall += 1;
            continue;
        }
        const indexed = touched.filter((path) => graph.idByPath.has(path));
        if (indexed.length < 2) {
            droppedNotIndexed += 1;
            continue;
        }
        commitsUsable += 1;
        for (const seed of indexed.toSorted().slice(0, SEEDS_PER_COMMIT)) {
            cases.push({ sha, seed, truth: indexed.filter((path) => path !== seed) });
        }
    }
    return { cases, commitsScanned: shas.length, commitsUsable, droppedNotIndexed, droppedTooSmall };
};

// Folder siblings, precomputed once: the no-graph baseline the walk has to beat before it earns its cost.
const siblingIndex = (graph: ImportGraph): Map<string, string[]> => {
    const byDir = new Map<string, string[]>();
    for (const path of graph.idByPath.keys()) {
        const dir = dirOf(path);
        (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(path);
    }
    for (const paths of byDir.values()) {
        paths.sort();
    }
    return byDir;
};

// Sharing a folder is weaker evidence than a written import edge and stronger than a two-step chain, so
// siblings sort between hop 1 and hop 2. Fixed a priori rather than tuned against these results — a ranking
// fitted to the test set is how a benchmark stops measuring anything.
const SIBLING_RANK = 1.5;

const siblingsOf = (byDir: ReadonlyMap<string, string[]>, seed: string): ImpactedFile[] =>
    (byDir.get(dirOf(seed)) ?? []).filter((path) => path !== seed).map((path) => ({ path, hops: SIBLING_RANK }));

const predictFor = (
    graph: ImportGraph,
    byDir: ReadonlyMap<string, string[]>,
    strategy: ImpactStrategy,
    seed: string,
): ImpactResult => {
    const fromGraph =
        strategy.maxHops === 0
            ? []
            : impactOf(graph, [seed], { maxHops: strategy.maxHops, cap: Number.MAX_SAFE_INTEGER, direction: strategy.direction }).reached;
    const fromDir = strategy.maxHops === 0 || strategy.withSiblings === true ? siblingsOf(byDir, seed) : [];
    // Nearest wins when both sources name the same file: a path's rank is the best evidence for it, not the
    // last one merged.
    const best = new Map<string, number>();
    for (const file of [...fromGraph, ...fromDir]) {
        const current = best.get(file.path);
        if (current === undefined || file.hops < current) {
            best.set(file.path, file.hops);
        }
    }
    const ranked = [...best]
        .map(([path, hops]) => ({ path, hops }))
        .toSorted((a, b) => a.hops - b.hops || (a.path < b.path ? -1 : 1));
    return { reached: ranked.slice(0, strategy.cap), truncated: Math.max(0, ranked.length - strategy.cap), unknownSeeds: [] };
};

const scoreOne = (
    predicted: readonly string[],
    truth: readonly string[],
): { truePositives: number; precision: number; recall: number; f1: number } => {
    const truthSet = new Set(truth);
    const truePositives = predicted.filter((path) => truthSet.has(path)).length;
    const precision = predicted.length === 0 ? 0 : truePositives / predicted.length;
    const recall = truth.length === 0 ? 0 : truePositives / truth.length;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { truePositives, precision, recall, f1 };
};

export const runImpact = async (options: { repo?: string } = {}): Promise<{ rows: ImpactRow[]; meta: ImpactMeta }> => {
    const repo = options.repo ?? "intentic";
    const root = repoRoot(repo);
    await ensureIndex(repo, root, undefined);
    const graph = loadImportGraph(indexDirFor(repo));
    const graphEdges = [...graph.imports.values()].reduce((sum, set) => sum + set.size, 0);
    const byDir = siblingIndex(graph);

    const { cases, commitsScanned, commitsUsable, droppedNotIndexed, droppedTooSmall } = buildImpactCases(root, graph);
    const rows: ImpactRow[] = [];
    for (const strategy of IMPACT_STRATEGIES) {
        for (const impactCase of cases) {
            const predicted = predictFor(graph, byDir, strategy, impactCase.seed);
            rows.push({
                strategy: strategy.name,
                sha: impactCase.sha,
                seed: impactCase.seed,
                truthCount: impactCase.truth.length,
                predictedCount: predicted.reached.length,
                truncated: predicted.truncated,
                ...scoreOne(
                    predicted.reached.map((file) => file.path),
                    impactCase.truth,
                ),
            });
        }
    }
    return {
        rows,
        meta: {
            repo,
            commitsScanned,
            commitsUsable,
            droppedNotIndexed,
            droppedTooSmall,
            cases: cases.length,
            graphFiles: graph.pathsById.size,
            graphEdges,
            shallow: git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true",
        },
    };
};
