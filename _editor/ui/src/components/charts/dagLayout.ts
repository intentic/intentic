import { graphlib, layout } from "@dagrejs/dagre";

// DagGraph's data model and dagre layout step. Nodes carry an opaque `data` payload for the #node slot; edges reference
// node ids. Layout uses dagre's layered algorithm (LR by default), which also breaks cycles.

export interface DagNode<T = unknown> {
    readonly id: string;
    // Opaque payload handed to the #node slot.
    readonly data: T;
    // Tooltip content for the node's card; DagGraph owns the card wrapper, so callers can't attach a directive.
    readonly tooltip?: string;
    // Closure highlighting: fade this node without removing it from the layout.
    readonly dimmed?: boolean;
    // Per-node size override for dagre, not the default nodeWidth/nodeHeight; e.g. a card sized by its rows.
    readonly width?: number;
    readonly height?: number;
}

export interface DagEdge {
    // Rendered source → target: `from` sits left of `to` in LR layout, with the curve flowing forward.
    readonly from: string;
    readonly to: string;
    // Discriminator when two edges share endpoints (e.g. a prod and a dev dep), part of the render key.
    readonly kind?: string;
    // e.g. dev deps.
    readonly dashed?: boolean;
    readonly dimmed?: boolean;
    // Text-color class (e.g. `text-warning`) the edge strokes at full opacity, to tint a selection's closure.
    readonly accent?: string;
}

export interface DagLayoutOptions {
    readonly direction: `LR` | `TB`;
    readonly nodeWidth: number;
    readonly nodeHeight: number;
    // Air between columns and cards in one; defaults suit few large cards, tighter needed for list-row cards.
    readonly rankSep?: number;
    readonly nodeSep?: number;
}

// Default column/card spacing when unset; an edge's outbound turn sits halfway across the rank gap.
const RANK_SEP = 88;
const NODE_SEP = 28;

// Comparable string of everything that decides node positions (ids/order, edges, direction, each node's box); DagGraph
// refits when it changes. Excludes labels, so a text-only change keeps the reader's pan.
export const layoutSignature = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[], options: DagLayoutOptions): string =>
    [
        options.direction,
        `${options.rankSep ?? RANK_SEP}/${options.nodeSep ?? NODE_SEP}`,
        nodes.map((node) => `${node.id}@${node.width ?? options.nodeWidth}x${node.height ?? options.nodeHeight}`).join(`,`),
        edges.map((edge) => `${edge.from}>${edge.to}`).join(`,`),
    ].join(`|`);

export interface DagPoint {
    readonly x: number;
    readonly y: number;
}

export interface DagPlacement {
    // Each node's top-left corner, by id; dagre itself yields centers.
    readonly nodes: ReadonlyMap<string, DagPoint>;
    // Where each edge turns, keyed by `laneKey`, in node coords: the last gap before its target.
    readonly lanes: ReadonlyMap<string, readonly DagPoint[]>;
}

// Keyed by endpoints alone: dagre gets one edge per pair, so two DagEdges differing only by `kind` share a lane.
export const laneKey = (from: string, to: string): string => `${from}>${to}`;

// Column is one past the deepest dependency, 0 if none: true depth, not dagre's own simplex ranking, which a reader
// expects. Cycles: the first blocked node is placed from whichever dependencies resolved.
const columnsOf = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[]): Map<string, number> => {
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const unresolved = new Map<string, number>();
    for (const edge of edges) {
        parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
        children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
        unresolved.set(edge.to, (unresolved.get(edge.to) ?? 0) + 1);
    }
    const columns = new Map<string, number>();
    const ready = nodes.filter((node) => (unresolved.get(node.id) ?? 0) === 0).map((node) => node.id);
    const place = (id: string): void => {
        const deepest = (parents.get(id) ?? []).reduce((depth, from) => Math.max(depth, (columns.get(from) ?? -1) + 1), 0);
        columns.set(id, deepest);
        for (const child of children.get(id) ?? []) {
            const left = (unresolved.get(child) ?? 1) - 1;
            unresolved.set(child, left);
            if (left === 0) {
                ready.push(child);
            }
        }
    };
    while (columns.size < nodes.length) {
        const id = ready.shift();
        const next = id ?? nodes.find((node) => !columns.has(node.id))?.id;
        if (next === undefined) {
            break;
        }
        if (!columns.has(next)) {
            place(next);
        }
    }
    return columns;
};

// One node as dagre placed it: a centre, and the box the caller asked for.
interface PlacedNode {
    readonly id: string;
    readonly at: DagPoint;
    readonly width: number;
    readonly height: number;
}

const boxOf = (node: DagNode<never>, options: DagLayoutOptions): { width: number; height: number } => ({
    width: node.width ?? options.nodeWidth,
    height: node.height ?? options.nodeHeight,
});

// A card nothing waits on has no continuation to be ordered by, and sorts after every card that has one.
const LAST_IN_COLUMN = Number.MAX_SAFE_INTEGER;

// Orders each column by where its line continues: sweeping right to left, a card sits above another when its nearest
// continuation does; ties keep dagre's order, nothing-waits-on sinks to the bottom.
const orderColumns = (columns: ReadonlyMap<string, number>, edges: readonly DagEdge[], seeded: readonly string[]): Map<string, number> => {
    const targets = new Map<string, string[]>();
    for (const edge of edges) {
        targets.set(edge.from, [...(targets.get(edge.from) ?? []), edge.to]);
    }
    const members = new Map<number, string[]>();
    for (const id of seeded) {
        const column = columns.get(id) ?? 0;
        members.set(column, [...(members.get(column) ?? []), id]);
    }

    const place = new Map<string, number>();
    // Nearest column+place this card's line continues to; only already-ordered columns strictly to the right count.
    const continuation = (id: string): readonly [number, number] =>
        (targets.get(id) ?? []).reduce<readonly [number, number]>(
            (best, to) => {
                const at = place.get(to);
                const column = columns.get(to);
                if (at === undefined || column === undefined) {
                    return best;
                }
                return column < best[0] || (column === best[0] && at < best[1]) ? [column, at] : best;
            },
            [LAST_IN_COLUMN, LAST_IN_COLUMN],
        );

    for (let column = Math.max(...members.keys(), 0); column >= 0; column -= 1) {
        const ordered = (members.get(column) ?? [])
            .map((id, seed) => ({ id, seed, key: continuation(id) }))
            .toSorted((one, other) => one.key[0] - other.key[0] || one.key[1] - other.key[1] || one.seed - other.seed);
        ordered.forEach((entry, index) => place.set(entry.id, index));
    }
    return place;
};

// Discards dagre's cross-axis coordinate; packs each column from the same top edge, one gap between cards, in
// orderColumns' order.
const packColumns = (placed: readonly PlacedNode[], horizontal: boolean, gap: number, order: ReadonlyMap<string, number>): Map<string, DagPoint> => {
    const columns = new Map<number, PlacedNode[]>();
    for (const entry of placed) {
        const rank = Math.round(horizontal ? entry.at.x : entry.at.y);
        columns.set(rank, [...(columns.get(rank) ?? []), entry]);
    }
    const packed = new Map<string, DagPoint>();
    for (const column of columns.values()) {
        let next = 0;
        for (const entry of column.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))) {
            packed.set(entry.id, {
                x: horizontal ? entry.at.x - entry.width / 2 : next,
                y: horizontal ? next : entry.at.y - entry.height / 2,
            });
            next += (horizontal ? entry.height : entry.width) + gap;
        }
    }
    return packed;
};

// Flow-relative axes so one routing implementation serves LR and TB layouts: `along` runs with the flow, `across` is
// what a column stacks on.
const along = (box: PlacedNode, horizontal: boolean): { start: number; end: number } =>
    horizontal ? { start: box.at.x, end: box.at.x + box.width } : { start: box.at.y, end: box.at.y + box.height };
const across = (box: PlacedNode, horizontal: boolean): { start: number; end: number } =>
    horizontal ? { start: box.at.y, end: box.at.y + box.height } : { start: box.at.x, end: box.at.x + box.width };

// Row stays the source's until the last possible turn (see turnPoints); if blocked, shifts to whichever row blocks
// fewest cards, nearest the source.
// - fan-out: edges leaving one card overlap into a single stroke, peeling apart near their targets
// - locality: a line stays near what it connects, never jumping early to the target's row
const laneAcross = (source: PlacedNode, target: PlacedNode, boxes: readonly PlacedNode[], horizontal: boolean, gap: number): number => {
    const mid = (box: PlacedNode): number => (across(box, horizontal).start + across(box, horizontal).end) / 2;
    const home = mid(source);
    // Only boxes fully between the two columns; the endpoints are never obstacles to their own edge.
    const between = boxes.filter(
        (box) => along(box, horizontal).start >= along(source, horizontal).end && along(box, horizontal).end <= along(target, horizontal).start,
    );
    const blocked = (lane: number): number =>
        between.filter((box) => lane > across(box, horizontal).start - 1 && lane < across(box, horizontal).end + 1).length;
    if (between.length === 0 || blocked(home) === 0) {
        return home;
    }
    // Candidate lanes are gaps around blocking boxes, bounded by the picture's rows; none sits past top or bottom.
    const first = Math.min(...boxes.map((box) => across(box, horizontal).start));
    const last = Math.max(...boxes.map((box) => across(box, horizontal).end));
    const gaps = between
        .flatMap((box) => [across(box, horizontal).start - gap / 2, across(box, horizontal).end + gap / 2])
        .filter((lane) => lane > first && lane < last);
    const candidates = [home, ...gaps];
    return candidates.reduce((best, lane) => {
        const better = blocked(lane) - blocked(best);
        return better < 0 || (better === 0 && Math.abs(lane - home) < Math.abs(best - home)) ? lane : best;
    }, home);
};

// Turn sits in the last gutter before the target, not the first after the source, so a fan-out leaves as one stroke. A
// blocked source row adds an earlier turn into the lane, then along it to the target's gutter.
const turnPoints = (
    edges: readonly DagEdge[],
    boxes: ReadonlyMap<string, PlacedNode>,
    horizontal: boolean,
    gutter: number,
    gap: number,
): Map<string, readonly DagPoint[]> => {
    const all = [...boxes.values()];
    const turns = new Map<string, readonly DagPoint[]>();
    const at = (alongValue: number, acrossValue: number): DagPoint =>
        horizontal ? { x: alongValue, y: acrossValue } : { x: acrossValue, y: alongValue };
    for (const edge of edges) {
        const source = boxes.get(edge.from);
        const target = boxes.get(edge.to);
        if (source === undefined || target === undefined) {
            continue;
        }
        const leaves = along(source, horizontal).end + gutter / 2;
        // Last gutter before target; `max` guards a reversed edge from turning behind its own source.
        const arrives = Math.max(along(target, horizontal).start - gutter / 2, leaves);
        const lane = laneAcross(source, target, all, horizontal, gap);
        const handle = (across(source, horizontal).start + across(source, horizontal).end) / 2;
        // Same row all the way is one turn; a lane detour is two turns, kept as short as the obstruction.
        turns.set(laneKey(edge.from, edge.to), lane === handle ? [at(arrives, lane)] : [at(leaves, lane), at(arrives, lane)]);
    }
    return turns;
};

export const layoutDag = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[], options: DagLayoutOptions): DagPlacement => {
    const graph = new graphlib.Graph();
    const rankSep = options.rankSep ?? RANK_SEP;
    const nodeSep = options.nodeSep ?? NODE_SEP;
    graph.setGraph({ rankdir: options.direction, nodesep: nodeSep, ranksep: rankSep });
    graph.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
        graph.setNode(node.id, boxOf(node, options));
    }
    const drawn = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    // Sets each edge's `minlen` to its column span, forcing simplex onto the depth order; crossing stays dagre's.
    const columns = columnsOf(nodes, drawn);
    for (const edge of drawn) {
        graph.setEdge(edge.from, edge.to, { minlen: Math.max(1, (columns.get(edge.to) ?? 0) - (columns.get(edge.from) ?? 0)) });
    }
    layout(graph);

    const horizontal = options.direction === `LR`;
    const placed = nodes.map((node): PlacedNode => {
        const at = graph.node(node.id);
        return { id: node.id, at: { x: at.x, y: at.y }, ...boxOf(node, options) };
    });
    // dagre's own cross-axis order seeds the ordering pass, which is where its crossing work is kept.
    const seeded = placed.toSorted((one, other) => (horizontal ? one.at.y - other.at.y : one.at.x - other.at.x)).map((entry) => entry.id);
    const packed = packColumns(placed, horizontal, nodeSep, orderColumns(columns, drawn, seeded));
    // Turns are measured off the packed boxes, not dagre's, since a line must leave the card where it now sits.
    const boxes = new Map(placed.map((entry): [string, PlacedNode] => [entry.id, { ...entry, at: packed.get(entry.id) ?? entry.at }]));
    return { nodes: packed, lanes: turnPoints(edges, boxes, horizontal, rankSep, nodeSep) };
};

// Right-angled path through `via`'s turns, rounded at the corners, so parallel edges share horizontal runs instead of
// splaying into curves. `from`/`to` are handle positions; no `via` takes one turn at the midpoint.
export const lanePath = (from: DagPoint, to: DagPoint, via: readonly DagPoint[] = [], radius = 8): string => {
    const turns = via.length > 0 ? via : [{ x: (from.x + to.x) / 2, y: from.y }];

    // Horizontal-first for every turn but the last, which goes vertical first so the line arrives horizontal.
    const waypoints = [from, ...turns, to];
    const corners: DagPoint[] = [];
    const push = (point: DagPoint): void => {
        const last = corners.at(-1);
        if (last !== undefined && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) {
            return;
        }
        const before = corners.at(-2);
        // A point in line with the two before it is not a corner: keeping it would round a bend that is straight.
        if (
            last !== undefined &&
            before !== undefined &&
            ((Math.abs(before.x - last.x) < 0.5 && Math.abs(last.x - point.x) < 0.5) ||
                (Math.abs(before.y - last.y) < 0.5 && Math.abs(last.y - point.y) < 0.5))
        ) {
            corners[corners.length - 1] = point;
            return;
        }
        corners.push(point);
    };
    push(from);
    waypoints.slice(1).forEach((point, index) => {
        const previous = waypoints[index] ?? from;
        const verticalFirst = index === waypoints.length - 2;
        push(verticalFirst ? { x: previous.x, y: point.y } : { x: point.x, y: previous.y });
        push(point);
    });

    const round = (value: number): number => Math.round(value * 100) / 100;
    // The point `radius` along the way from a corner towards its neighbour, where the arc starts or ends.
    const cut = (corner: DagPoint, towards: DagPoint): DagPoint => {
        const dx = towards.x - corner.x;
        const dy = towards.y - corner.y;
        const length = Math.hypot(dx, dy);
        const step = length === 0 ? 0 : Math.min(radius, length / 2) / length;
        return { x: corner.x + dx * step, y: corner.y + dy * step };
    };
    const [head, ...rest] = corners;
    if (head === undefined) {
        return ``;
    }
    const tail = rest.at(-1) ?? head;
    const bends = rest.slice(0, -1).map((corner, index) => {
        const previous = corners[index] ?? head;
        const next = rest[index + 1] ?? tail;
        const enter = cut(corner, previous);
        const leave = cut(corner, next);
        return `L ${round(enter.x)} ${round(enter.y)} Q ${round(corner.x)} ${round(corner.y)} ${round(leave.x)} ${round(leave.y)}`;
    });
    return [`M ${round(head.x)} ${round(head.y)}`, ...bends, `L ${round(tail.x)} ${round(tail.y)}`].join(` `);
};
