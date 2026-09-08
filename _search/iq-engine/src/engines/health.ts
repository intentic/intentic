import type { WorkspaceSearchFreshness } from "@intentic/sandbox-contract";
import type { IndexDb } from "../store/db.js";
import type { FileEntry, Scope } from "../types.js";
import { filterScope } from "../workspace/scan.js";
import { type HotspotFile, rankHotspots } from "./hotspots.js";
import { repoMap } from "./map.js";

// One repository's health as numbers, what `hotspots` and `map` rank, shaped for the daemon's /workspace/health panel.
// Every figure is a count re-derivable from the files themselves; never a composite maintainability score.

export interface HealthTotals {
    // Indexed files in scope; ignored and junk paths are already excluded.
    readonly files: number;
    readonly symbols: number;
    // Summed branch points (indexer/complexity.ts) over the scoped files.
    readonly complexity: number;
    // Files with churn and branch points, the risk surface `hotspots` ranks; the list below is only a sample.
    readonly hotspots: number;
}

// One file of the import graph's ranked skeleton (`map`): position by PageRank, exports is its surface. Array order is
// the rank; no rank number is stored.
export interface KeyModule {
    readonly path: string;
    readonly exports: number;
}

// Built fresh per call and sent straight onto the wire (daemon's /workspace/health); plain arrays, not readonly views.
// The contract schema is the authority on this shape.
export interface CodebaseHealth {
    readonly totals: HealthTotals;
    readonly hotspots: HotspotFile[];
    readonly modules: KeyModule[];
    // How current the index behind these figures is; distinguishes an unindexed codebase from a mid-build one.
    readonly freshness: WorkspaceSearchFreshness;
}

export interface HealthRequest {
    readonly scope: Scope;
    // Churn window; omitted means all of history, matching the verb's default.
    readonly since?: string;
    // How many hotspot files and key modules to return; the panel shows a leaderboard, not the whole repo.
    readonly limit: number;
}

export interface HealthContext {
    readonly db: IndexDb;
    readonly root: string;
    readonly freshness: WorkspaceSearchFreshness;
}

// Per-file symbol counts and branch points in one pass over the index; filtering happens in memory against the scoped
// path set rather than in SQL.
const fileStats = (db: IndexDb, allowed: ReadonlySet<string>): { symbols: number; complexity: number } => {
    let symbols = 0;
    let complexity = 0;
    for (const row of db.all(
        "SELECT f.path AS path, f.complexity AS complexity, COUNT(s.id) AS symbols FROM files f LEFT JOIN symbols s ON s.file_id = f.id GROUP BY f.id",
    )) {
        if (!allowed.has(row["path"] as string)) {
            continue;
        }
        symbols += Number(row["symbols"]);
        complexity += Number(row["complexity"]);
    }
    return { symbols, complexity };
};

export const codebaseHealth = async (context: HealthContext, request: HealthRequest, entries: readonly FileEntry[]): Promise<CodebaseHealth> => {
    const scoped = filterScope(entries, request.scope);
    const allowed = new Set(scoped.map((entry) => entry.path));
    const hotspots = await rankHotspots(context.db, context.root, scoped, request.since !== undefined ? { since: request.since } : {});
    return {
        totals: { files: scoped.length, ...fileStats(context.db, allowed), hotspots: hotspots.length },
        hotspots: hotspots.slice(0, request.limit),
        modules: repoMap(context.db, allowed)
            .slice(0, request.limit)
            .map((group) => ({ path: group.path, exports: group.hits.length })),
        freshness: context.freshness,
    };
};
