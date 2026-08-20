import type { WorkspaceSearchFreshness } from "@intentic/sandbox-contract";
import type { IndexDb } from "../store/db.js";
import type { FileEntry, Scope } from "../types.js";
import { filterScope } from "../workspace/scan.js";
import { type HotspotFile, rankHotspots } from "./hotspots.js";
import { repoMap } from "./map.js";

/* One repository's health as NUMBERS rather than terminal lines, what the `hotspots` and `map` verbs rank,
 * shaped for a panel that plots it. The daemon serves this at /workspace/health and the browser draws it beside
 * the repo's management panel and git history; the verbs keep rendering the same rankings as text for the agent.
 *
 * Every figure here is a count you can go and recount in the files themselves (branch points, symbols, commits)
 *, deliberately not a composite "maintainability score", which is unfalsifiable and not comparable between
 * projects. The reader's judgement is the thing being served, so the panel must not launder counts into a grade. */

export interface HealthTotals {
    // Indexed files in scope, the sweep's admitted set, so ignored/junk paths are already gone.
    readonly files: number;
    readonly symbols: number;
    // Summed branch points (indexer/complexity.ts) over the scoped files.
    readonly complexity: number;
    // Files carrying BOTH churn and branch points, the risk surface `hotspots` ranks. The list below is capped;
    // this is how many there are.
    readonly hotspots: number;
}

// One file of the import graph's ranked skeleton (`map`): where it sits by PageRank, and how much surface it
// exposes. The order IS the rank, so no rank number rides along.
export interface KeyModule {
    readonly path: string;
    readonly exports: number;
}

// The arrays are freshly built per call and go straight onto the wire (the daemon's /workspace/health), so they
// are plain arrays rather than readonly views, the contract schema is the authority on this shape.
export interface CodebaseHealth {
    readonly totals: HealthTotals;
    readonly hotspots: HotspotFile[];
    readonly modules: KeyModule[];
    // How current the index these figures came from is, a panel drawn mid-build would otherwise read as a
    // codebase with no symbols rather than one that hasn't been indexed yet.
    readonly freshness: WorkspaceSearchFreshness;
}

export interface HealthRequest {
    readonly scope: Scope;
    // Churn window; omitted means all of history, exactly as the verb defaults.
    readonly since?: string;
    // How many hotspot files and key modules to return, the panel shows a leaderboard, not the whole repo.
    readonly limit: number;
}

export interface HealthContext {
    readonly db: IndexDb;
    readonly root: string;
    readonly freshness: WorkspaceSearchFreshness;
}

// Per-file symbol counts and branch points in ONE pass over the index. Filtering in SQL would need the scoped
// path set as a parameter list; the index is thousands of rows, so reading it and intersecting in memory is both
// simpler and faster than a query built per request.
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
