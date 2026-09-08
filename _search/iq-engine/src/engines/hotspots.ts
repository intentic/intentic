import type { IndexDb } from "../store/db.js";
import type { FileEntry, RankedGroup } from "../types.js";
import { churnOf, type ChurnOptions } from "./git.js";

// `iq hotspots`: files both frequently changed and structurally complex, ranked by commits × complexity. Churn is git
// history (or the --since window); complexity comes from index time; a file needs both to place.

export interface HotspotOptions extends ChurnOptions {
    readonly pattern?: string;
}

// One ranked file as numbers; the terminal verb formats these into text and the health panel (engines/health.ts) plots
// them.
export interface HotspotFile {
    readonly path: string;
    readonly commits: number;
    readonly adds: number;
    readonly dels: number;
    readonly complexity: number;
    // commits × complexity, the risk product this ranks by.
    readonly score: number;
    readonly latestMs: number;
}

export const rankHotspots = async (db: IndexDb, root: string, entries: readonly FileEntry[], options: HotspotOptions): Promise<HotspotFile[]> => {
    const complexity = new Map(
        db.all("SELECT path, complexity FROM files WHERE complexity > 0").map((row) => [row["path"] as string, Number(row["complexity"])]),
    );
    const churn = await churnOf(root, entries, options);
    const pattern = options.pattern !== undefined && options.pattern !== "" ? options.pattern.toLowerCase() : undefined;
    return [...churn.entries()]
        .flatMap(([path, activity]) => {
            const cx = complexity.get(path) ?? 0;
            // A file needs both signals to place: no branch points means no risk product, no row.
            if (cx === 0 || (pattern !== undefined && !path.toLowerCase().includes(pattern))) {
                return [];
            }
            return [
                {
                    path,
                    commits: activity.commits,
                    adds: activity.adds,
                    dels: activity.dels,
                    complexity: cx,
                    score: activity.commits * cx,
                    latestMs: activity.latestMs,
                },
            ];
        })
        .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
};

export const hotspotFiles = async (db: IndexDb, root: string, entries: readonly FileEntry[], options: HotspotOptions): Promise<RankedGroup[]> =>
    (await rankHotspots(db, root, entries, options)).map((file, rank) => {
        const score = 1 / (rank + 1);
        const summary = `${file.commits} commit${file.commits === 1 ? "" : "s"}   +${file.adds} -${file.dels}   cx ${file.complexity}   score ${file.score}`;
        return { path: file.path, score, hits: [{ path: file.path, line: 1, text: summary, tags: [], score }] };
    });
