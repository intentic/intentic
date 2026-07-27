import type { IndexDb } from "../store/db.js";
import type { FileEntry, RankedGroup } from "../types.js";
import { churnOf, type ChurnOptions } from "./git.js";

// `iq hotspots` — the files that are BOTH frequently changed and structurally tangled. Either signal alone
// misleads: a churning config file is trivial, and a gnarly file nobody touches costs nobody anything. Their
// product is where defects and reading time concentrate, and it is the one ranking neither the file tree nor
// the dependency graph can produce.
//
// Churn comes from git (all of history unless --since narrows it); complexity was counted at index time
// (indexer/complexity.ts). A file needs both to place: never-committed files and files with no branch points
// (markdown, JSON, config) score zero and drop out, which is what makes the list read as "the code that matters".

export interface HotspotOptions extends ChurnOptions {
    readonly pattern?: string;
}

export const hotspotFiles = async (db: IndexDb, root: string, entries: readonly FileEntry[], options: HotspotOptions): Promise<RankedGroup[]> => {
    const complexity = new Map(
        db.all("SELECT path, complexity FROM files WHERE complexity > 0").map((row) => [row["path"] as string, Number(row["complexity"])]),
    );
    const churn = await churnOf(root, entries, options);
    const pattern = options.pattern !== undefined && options.pattern !== "" ? options.pattern.toLowerCase() : undefined;
    return [...churn.entries()]
        .map(([path, entry]) => {
            const cx = complexity.get(path) ?? 0;
            return { path, entry, cx, product: entry.commits * cx };
        })
        .filter((item) => item.cx > 0 && (pattern === undefined || item.path.toLowerCase().includes(pattern)))
        .toSorted((a, b) => b.product - a.product || (a.path < b.path ? -1 : 1))
        .map((item, rank) => {
            const score = 1 / (rank + 1);
            const summary = `${item.entry.commits} commit${item.entry.commits === 1 ? "" : "s"}   +${item.entry.adds} -${item.entry.dels}   cx ${item.cx}   score ${item.product}`;
            return { path: item.path, score, hits: [{ path: item.path, line: 1, text: summary, tags: [], score }] };
        });
};
