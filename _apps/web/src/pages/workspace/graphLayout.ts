import type { GitCommit } from "@intentic-app/api-contract";

/* The commit-graph lane layout — the pure geometry behind GitGraph.vue. Given commits newest-first in topo
 * order (as `git log --all --topo-order` returns them), it assigns every commit a lane (column) and emits, per
 * row, the line segments to draw: a top half (lanes entering the row, bending into the node where they are the
 * node's children) and a bottom half (the node's parents leaving toward their lanes). This is the standard
 * "two half-edges per row" model VSCode's graph renderers use; keeping it pure makes it unit-testable and lets
 * the component stay a thin SVG mapping.
 *
 * Parents outside the fetched window are dropped, so a commit whose parents predate the limit ends its lane at
 * its own row (it reads like a root) — raising the log limit reveals the continuation. */

export interface GraphEdge {
    // Lane columns at the segment's two ends. A top-half edge runs from `from` (top of the row) to `to` (row
    // center); a bottom-half edge from `from` (center) to `to` (bottom). Equal ends = a straight vertical line.
    readonly from: number;
    readonly to: number;
    // Palette index (the destination lane) — a branch keeps one colour as it flows down a column.
    readonly color: number;
}

export interface GraphRow {
    readonly sha: string;
    // The commit node's lane column, and its colour (that lane's palette index).
    readonly col: number;
    readonly color: number;
    // Top half: lanes entering the row → the node center (children merging in are the edges bending to `col`).
    readonly up: readonly GraphEdge[];
    // Bottom half: the node center → the lanes leaving the row (extra parents branch out from `col`).
    readonly down: readonly GraphEdge[];
}

export interface GraphLayout {
    readonly rows: readonly GraphRow[];
    // The widest lane count across all rows — the gutter's column count.
    readonly laneCount: number;
}

const firstFree = (lanes: readonly (string | undefined)[]): number => {
    const hole = lanes.indexOf(undefined);
    return hole === -1 ? lanes.length : hole;
};

export const computeGraphLayout = (commits: readonly GitCommit[]): GraphLayout => {
    const known = new Set(commits.map((commit) => commit.sha));
    // Each active lane holds the sha it is currently waiting to draw next (undefined = a free/reusable column).
    const lanes: (string | undefined)[] = [];
    const rows: GraphRow[] = [];
    let maxLane = 0;

    for (const commit of commits) {
        const incoming = lanes.flatMap((sha, index) => (sha === commit.sha ? [index] : []));
        const col = incoming.length > 0 ? Math.min(...incoming) : firstFree(lanes);
        if (col >= lanes.length) {
            lanes[col] = undefined;
        }

        // Top half: every lane active BEFORE this commit. Lanes waiting for it bend into the node (to `col`);
        // the rest pass straight through.
        const up: GraphEdge[] = [];
        lanes.forEach((sha, index) => {
            if (sha === undefined) {
                return;
            }
            const to = sha === commit.sha ? col : index;
            up.push({ from: index, to, color: to });
        });

        // Advance the lanes: the merged-in children lanes are freed, then the commit's in-window parents take
        // lanes — the first continues in `col`, each extra one opens (or reuses) a lane and branches out.
        for (const index of incoming) {
            lanes[index] = undefined;
        }
        const parents = commit.parents.filter((parent) => known.has(parent));
        const extra: number[] = [];
        if (parents.length > 0) {
            lanes[col] = parents[0];
            for (const parent of parents.slice(1)) {
                const lane = firstFree(lanes);
                lanes[lane] = parent;
                extra.push(lane);
            }
        } else {
            lanes[col] = undefined;
        }

        // Bottom half: every lane active AFTER the advance. `col` and the pass-throughs go straight down; the
        // extra-parent lanes branch out from the node.
        const down: GraphEdge[] = [];
        lanes.forEach((sha, index) => {
            if (sha === undefined) {
                return;
            }
            const from = index === col || extra.includes(index) ? col : index;
            down.push({ from, to: index, color: index });
        });

        rows.push({ sha: commit.sha, col, color: col, up, down });
        maxLane = Math.max(maxLane, lanes.length, col + 1);
    }

    return { rows, laneCount: maxLane };
};
