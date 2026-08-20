import type { GitCommit } from "@intentic/sandbox-contract";

/* The commit-graph lane layout, the pure geometry behind GitHistoryTab.vue. Given commits newest-first in topo
 * order (as `git log --all --topo-order` returns them), it assigns every commit a lane (column) and emits, per
 * row, the line segments to draw: a top half (lanes entering the row, bending into the node where they are the
 * node's children) and a bottom half (the node's parents leaving toward their lanes). This is the standard
 * "two half-edges per row" model VSCode's graph renderers use; keeping it pure makes it unit-testable and lets
 * the component stay a thin SVG mapping.
 *
 * COLOUR FOLLOWS THE BRANCH, NOT THE COLUMN, the one rule here that is not obvious, and the one a reader
 * actually navigates by. Colouring by lane index is the cheap version and it is wrong in both directions: two
 * unrelated branches that happen to reuse a freed column come out the same colour, and a branch that shifts
 * columns changes colour halfway down. So a colour is allocated when a branch BEGINS, travels with it through
 * every column it occupies, and is only handed out again once that branch has ended. It is the rule
 * vscode-git-graph uses, and the reason a merge edge keeps the colour of the branch merging IN rather than
 * adopting the colour of whatever it merges into.
 *
 * Parents outside the fetched window are dropped, so a commit whose parents predate the limit ends its lane at
 * its own row (it reads like a root), raising the log limit reveals the continuation. */

export interface GraphEdge {
    // Lane columns at the segment's two ends. A top-half edge runs from `from` (top of the row) to `to` (row
    // center); a bottom-half edge from `from` (center) to `to` (bottom). Equal ends = a straight vertical line.
    readonly from: number;
    readonly to: number;
    // Palette index of the BRANCH this segment belongs to, stable for the branch's whole descent, so a reader
    // can follow one colour from a tip down to wherever it was forked from.
    readonly color: number;
}

export interface GraphRow {
    readonly sha: string;
    // The commit node's lane column, and its branch's colour.
    readonly col: number;
    readonly color: number;
    // Top half: lanes entering the row → the node center (children merging in are the edges bending to `col`).
    readonly up: readonly GraphEdge[];
    // Bottom half: the node center → the lanes leaving the row (extra parents branch out from `col`).
    readonly down: readonly GraphEdge[];
}

export interface GraphLayout {
    readonly rows: readonly GraphRow[];
    // The widest lane count across all rows, the gutter's column count.
    readonly laneCount: number;
}

// An occupied lane: the sha it is waiting to draw next, and the colour of the branch flowing through it.
interface Lane {
    readonly sha: string;
    readonly color: number;
}

const firstFree = (lanes: readonly (Lane | undefined)[]): number => {
    const hole = lanes.indexOf(undefined);
    return hole === -1 ? lanes.length : hole;
};

/* The lowest palette index no LIVE branch is holding. Reuse is what keeps a long history inside a small palette;
 * gating it on the active lanes is what stops a reused colour from appearing twice at the same height, which is
 * the failure that makes two unrelated branches read as one. */
const freeColor = (lanes: readonly (Lane | undefined)[]): number => {
    const used = new Set(lanes.flatMap((lane) => (lane === undefined ? [] : [lane.color])));
    for (let color = 0; ; color += 1) {
        if (!used.has(color)) {
            return color;
        }
    }
};

export const computeGraphLayout = (commits: readonly GitCommit[]): GraphLayout => {
    const known = new Set(commits.map((commit) => commit.sha));
    const lanes: (Lane | undefined)[] = [];
    const rows: GraphRow[] = [];
    let maxLane = 0;

    for (const commit of commits) {
        const incoming = lanes.flatMap((lane, index) => (lane?.sha === commit.sha ? [index] : []));
        const col = incoming.length > 0 ? Math.min(...incoming) : firstFree(lanes);
        if (col >= lanes.length) {
            lanes[col] = undefined;
        }
        // A commit some lane was waiting for continues that lane's branch and keeps its colour. One nothing was
        // waiting for is a TIP, a branch head, or the newest commit of a disconnected component, and so starts
        // a branch of its own.
        const color = lanes[col]?.color ?? freeColor(lanes);

        // Top half: every lane active BEFORE this commit. Lanes waiting for it bend into the node (to `col`);
        // the rest pass straight through. Each segment keeps ITS OWN lane's colour, which is what lets a merge
        // edge stay the colour of the branch coming in.
        const up = lanes.flatMap((lane, index) =>
            lane === undefined ? [] : [{ from: index, to: lane.sha === commit.sha ? col : index, color: lane.color }],
        );

        // Advance the lanes: the merged-in children lanes are freed (releasing their colours), then the commit's
        // in-window parents take lanes, the first continues in `col` carrying this branch's colour, each extra
        // one opens (or reuses) a lane and starts a branch of its own.
        for (const index of incoming) {
            lanes[index] = undefined;
        }
        const parents = commit.parents.filter((parent) => known.has(parent));
        const extra: number[] = [];
        const [first, ...rest] = parents;
        if (first !== undefined) {
            lanes[col] = { sha: first, color };
            for (const parent of rest) {
                const lane = firstFree(lanes);
                // Allocated with `col` already occupied above, so a second parent can never be handed this
                // branch's own colour.
                lanes[lane] = { sha: parent, color: freeColor(lanes) };
                extra.push(lane);
            }
        } else {
            lanes[col] = undefined;
        }

        // Bottom half: every lane active AFTER the advance. `col` and the pass-throughs go straight down; the
        // extra-parent lanes branch out from the node.
        const down = lanes.flatMap((lane, index) =>
            lane === undefined ? [] : [{ from: index === col || extra.includes(index) ? col : index, to: index, color: lane.color }],
        );

        rows.push({ sha: commit.sha, col, color, up, down });
        maxLane = Math.max(maxLane, lanes.length, col + 1);
    }

    return { rows, laneCount: maxLane };
};
