import type { GitCommit } from "@intentic/sandbox-contract";

// Pure geometry for the commit-graph lanes GitHistoryTab.vue draws: per commit, a lane, then a top half (incoming edges
// bending into the node) and a bottom half (parents leaving). Colour follows the branch, not the lane column: allocated
// when a branch begins, carried through every column it occupies, freed only once it ends. A parent outside the fetched
// window ends its lane at that row, like a root.

export interface GraphEdge {
    // Lane columns at each end: top half runs row-top to center, bottom half center to row-bottom; equal ends draw a
    // straight line.
    readonly from: number;
    readonly to: number;
    // Palette index of the branch owning this segment, stable across its whole descent from where it forked.
    readonly color: number;
}

export interface GraphRow {
    readonly sha: string;
    // The commit node's lane column, and its branch's colour.
    readonly col: number;
    readonly color: number;
    // Lanes entering the row toward the node center; children merging in bend to `col`.
    readonly up: readonly GraphEdge[];
    // The node center toward the lanes leaving the row; extra parents branch out from `col`.
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

// Lowest palette index held by no active lane. Gated on active lanes so a reused colour never appears twice at the same
// row height.
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
        // A commit some lane awaited continues that lane's colour; one nothing awaited is a tip, and starts a new
        // branch.
        const color = lanes[col]?.color ?? freeColor(lanes);

        // Lanes active before this commit: ones waiting for it bend to `col`, the rest pass straight through, each
        // keeping its own colour.
        const up = lanes.flatMap((lane, index) =>
            lane === undefined ? [] : [{ from: index, to: lane.sha === commit.sha ? col : index, color: lane.color }],
        );

        // Advances the lanes: frees the merged-in children's, continues the first parent in `col`, opens a lane for
        // each extra parent.
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
                // Allocated after `col` is already filled, so a second parent can never get this branch's own colour.
                lanes[lane] = { sha: parent, color: freeColor(lanes) };
                extra.push(lane);
            }
        } else {
            lanes[col] = undefined;
        }

        // Bottom half: every lane active after the advance; `col` and pass-throughs go straight down, extra-parent
        // lanes branch out.
        const down = lanes.flatMap((lane, index) =>
            lane === undefined ? [] : [{ from: index === col || extra.includes(index) ? col : index, to: index, color: lane.color }],
        );

        rows.push({ sha: commit.sha, col, color, up, down });
        maxLane = Math.max(maxLane, lanes.length, col + 1);
    }

    return { rows, laneCount: maxLane };
};
