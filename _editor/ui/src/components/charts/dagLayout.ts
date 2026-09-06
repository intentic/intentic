import { graphlib, layout } from "@dagrejs/dagre";

/* The DagGraph component's data model + its dagre layout step. Nodes carry an opaque `data` payload rendered
 * by the caller's #node slot; edges reference node ids. Layout is dagre's layered algorithm (LR by default),
 * which replaced the hand-rolled longest-chain layering this lib's consumers used before, dagre also breaks
 * cycles instead of needing a visiting guard. */

export interface DagNode<T = unknown> {
    readonly id: string;
    // Opaque payload handed to the #node slot.
    readonly data: T;
    // Tooltip content for the node's card (DagGraph owns the card wrapper, so the caller
    // can't attach a directive itself).
    readonly tooltip?: string;
    // Closure highlighting: fade this node without removing it from the layout.
    readonly dimmed?: boolean;
    // Per-node size overrides: when set, dagre lays this node out at these dimensions instead of the
    // caller's default nodeWidth/nodeHeight. Used for compound nodes (e.g. a pipeline stage grouping
    // several jobs into one card) whose height scales with the number of items inside.
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
    // A text color class (e.g. `text-warning`), the edge path strokes with currentColor at full opacity,
    // used to tint a selection's closure by direction.
    readonly accent?: string;
}

export interface DagLayoutOptions {
    readonly direction: `LR` | `TB`;
    readonly nodeWidth: number;
    readonly nodeHeight: number;
    /* HOW MUCH AIR THE PICTURE GETS: between two columns, and between two cards in one. The defaults suit a
     * graph of few large cards, which is what a note's map or a designer's canvas is. A card that is a LIST
     * wants both tighter: a run's card is a stack of 26px rows, and spacing measured for a 64px card leaves a
     * 26-job run twice as wide as it needs to be, which is the whole difference between a diagram that fits its
     * frame legibly and one that has to be panned. */
    readonly rankSep?: number;
    readonly nodeSep?: number;
}

// The air a graph gets when its caller names none: dagre is told both, and the turn a line makes on its way out
// of a column is placed halfway across the first of them.
const RANK_SEP = 88;
const NODE_SEP = 28;

/* WHICH GRAPH IS ON SCREEN, everything that decides where the nodes end up, as one comparable string.
 *
 * DagGraph refits its viewport when this changes. It used to watch the node COUNT instead, which is not an
 * identity: two different six-node graphs share a count, so navigating between them left the previous graph's
 * pan and zoom applied to the new one. Where that bit hardest was a small graph followed by a large one, the
 * small one's fit had clamped to maxZoom, and the large one then rendered at 2×, which reads as "zoomed in way
 * too much" rather than as a stale transform.
 *
 * It stays a string rather than a structural compare because a watcher needs a cheap, stable value, and it
 * covers exactly the layout inputs: ids and their order, the edges between them, the direction, and each
 * node's box, which is the caller's default unless the node overrode it. A box belongs here because it moves
 * everything downstream of it: a compound card that grows a row re-ranks its whole column, and a fit measured
 * for the old height leaves the new one clipped. Node LABELS are deliberately absent, re-rendering the same
 * shape with new text must not throw away a pan the user chose. */
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
    // Each node's TOP-LEFT corner, by id, which is what a renderer positions with. dagre yields centres.
    readonly nodes: ReadonlyMap<string, DagPoint>;
    /* WHERE EACH EDGE TURNS, keyed by `laneKey`, in the same coordinates as the nodes: the LAST gap before its
     * target, so a line keeps its source's row across the picture and changes row only on arrival.
     *
     * Every edge leaving one card therefore starts on the same row and they overlap into one stroke that peels
     * apart near its targets, which is what makes a fan-out read as one line rather than a dozen diagonals, and
     * it is what the vendors' own run graphs draw. An edge whose row is blocked carries a second turn (see
     * turnPoints). */
    readonly lanes: ReadonlyMap<string, readonly DagPoint[]>;
}

// Edges are keyed by their endpoints alone: dagre is given one edge per pair, so two DagEdges that differ only
// by `kind` were laid out as one and share its lane.
export const laneKey = (from: string, to: string): string => `${from}>${to}`;

/* WHICH COLUMN EACH NODE BELONGS IN: one past its deepest dependency, and column 0 for anything that has none.
 *
 * dagre does not rank a node by its depth. Network simplex minimises the TOTAL length of the edges, so a node is
 * free to drift later than its dependencies require whenever that shortens the lines around it, and a root whose
 * consumers all sit far to the right drifts with them. On the workspace's own CI run that put `preflight`, which
 * waits for nothing at all, one column right of `changes` and shifted everything downstream of it a column too,
 * which reads as "preflight waits for changes" and is exactly wrong.
 *
 * Depth is the ranking a reader assumes and the one the vendors' own run graphs draw: column N holds the jobs
 * that could not have started before N others finished. Cycles cannot be ranked this way, so the first node that
 * a cycle would leave unplaced is cut loose and placed from whatever of its dependencies did resolve. */
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

/* WHERE IN ITS COLUMN EACH CARD SITS, which is the difference between a flow you follow along the top of the
 * picture and one you have to hunt down and back up again.
 *
 * dagre's crossing minimisation is the seed and the tiebreak, not the answer. It optimises a NUMBER, and two
 * orders with equally few crossings do not read equally: on this workspace's own CI run it put `ci-base` last in
 * its column while the job it feeds sat at the top of the next one, and left the run's dead ends (`migrations`,
 * the e2e pair, the two nothing waits on) in the middle of the spine. Following one branch meant zig-zagging
 * across the whole diagram.
 *
 * So a column is ordered by WHERE ITS LINE CONTINUES. Sweeping right to left, a card sits above another when its
 * nearest continuation sits above the other's: nearest by column first, then by place within it, and a card
 * nothing waits on sinks to the bottom. Ties keep dagre's order, so its work survives wherever this rule is
 * indifferent. On the run above it reproduces GitHub's own ordering column for column. */
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
    // The nearest place this card's line continues to. Only columns already ordered (strictly to the right) can
    // answer, so an edge inside a column or back across one is no continuation and simply does not count.
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

/* dagre's COORDINATE along a column is thrown away, and that is the whole of this pass.
 *
 * dagre places a node near the average of its neighbours so that edges come out straight, and pays for it in
 * empty space. On the workspace's own CI run it left gaps of 121, 204 and 391 pixels INSIDE one column, started
 * the second column four hundred pixels below the first, and drew 500px of content in a picture 944px tall.
 * Six columns each beginning somewhere different read as a scatter rather than as a flow.
 *
 * So every column is packed from the same top, one gap between cards, in the order orderColumns settled, which
 * is what GitHub's and GitLab's own run graphs do. Edges give up their straightness and gain a step, which the
 * elbow routing draws as a step; the reader gains a block that can be taken in at once. */
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

/* A box on the two axes the FLOW names rather than the two the screen does, so one implementation of the
 * routing below serves a left-to-right graph and a top-to-bottom one. `along` runs with the flow (the columns
 * march along it), `across` is the one a column is stacked on and a lane runs along. */
const along = (box: PlacedNode, horizontal: boolean): { start: number; end: number } =>
    horizontal ? { start: box.at.x, end: box.at.x + box.width } : { start: box.at.y, end: box.at.y + box.height };
const across = (box: PlacedNode, horizontal: boolean): { start: number; end: number } =>
    horizontal ? { start: box.at.y, end: box.at.y + box.height } : { start: box.at.x, end: box.at.x + box.width };

/* WHICH ROW A LONG EDGE TRAVELS ON, and the answer is ITS SOURCE'S, for as far as it can.
 *
 * A line leaves a card and keeps that card's row until the last moment, then makes one turn into its target.
 * Everything about how a graph reads follows from that:
 *
 *   - A FAN-OUT IS ONE LINE. Six edges out of one card all start on its row, so they overlap into a single
 *     stroke and peel off one at a time as each target arrives. Turning early instead gave six separate lines
 *     leaving one card, which is the "spaghetti" a reader means.
 *   - A LINE STAYS NEAR WHAT IT CONNECTS. Turning early and running at the TARGET's row puts the long stroke
 *     wherever the target happens to sit, so an edge to a card at the top of the picture hauled a line up and
 *     across the whole diagram, far from either end. Nothing on screen explained where it came from.
 *
 * It is also, exactly, what GitHub's own run graph draws, which is the reference that keeps being right here.
 *
 * WHEN THE SOURCE'S ROW IS BLOCKED, and only then, the edge shifts to a lane: the row that hits the FEWEST
 * cards standing between the two columns, nearest to the source's row. Fewest rather than none, honestly:
 * columns are packed independently, so their gaps do not line up and a lane free the whole way often does not
 * exist. A line entering a card and leaving the other side reads as going THROUGH it whatever the z-order says
 * (the cards paint on top, so it really passes behind), and nineteen of forty edges did that before any of
 * this. */
const laneAcross = (source: PlacedNode, target: PlacedNode, boxes: readonly PlacedNode[], horizontal: boolean, gap: number): number => {
    const mid = (box: PlacedNode): number => (across(box, horizontal).start + across(box, horizontal).end) / 2;
    const home = mid(source);
    // Only what stands BETWEEN them: a box whose whole span sits after the source's column and before the
    // target's. The two endpoints are not obstacles to their own edge.
    const between = boxes.filter(
        (box) => along(box, horizontal).start >= along(source, horizontal).end && along(box, horizontal).end <= along(target, horizontal).start,
    );
    const blocked = (lane: number): number =>
        between.filter((box) => lane > across(box, horizontal).start - 1 && lane < across(box, horizontal).end + 1).length;
    if (between.length === 0 || blocked(home) === 0) {
        return home;
    }
    /* The gaps those cards leave, one candidate in the middle of each, plus the row the edge would have taken.
     *
     * Bounded by the WHOLE picture's rows, so a lane outside it is never offered: past the topmost card or the
     * bottom one is always free of obstacles and always the wrong answer, a stroke sailing along the outside of
     * the diagram with nothing beside it to say what it belongs to. Bounded by the obstruction instead, one
     * card between two columns would rule out its own two gaps, which are the only lanes there are. */
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

/* WHERE EACH EDGE TURNS, and it is LATE: in the last gutter before its target, not the first one after its
 * source.
 *
 * The ordinary edge therefore has ONE turn. It keeps its source's row all the way across, steps to the target's
 * row in the gutter immediately before it, and goes in — so a fan-out leaves its card as a single stroke that
 * peels apart near its targets, and no line is ever drawn far from both of its ends (see laneAcross).
 *
 * An edge whose source row is BLOCKED gets two turns instead: out into its lane in the first gutter, along the
 * lane past whatever stands in the way, then to the target's row in the last gutter. `lanePath` renders any
 * number of turns; these are the only two shapes this produces. */
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
        // The gutter the line turns in, which is the LAST one: `max` because a backwards edge (a cycle dagre
        // reversed, a graph laid out against its own flow) would otherwise be told to turn behind its source.
        const arrives = Math.max(along(target, horizontal).start - gutter / 2, leaves);
        const lane = laneAcross(source, target, all, horizontal, gap);
        const handle = (across(source, horizontal).start + across(source, horizontal).end) / 2;
        // Keeping its own row all the way is one turn. Shifting to a lane is two: into the lane early, out of it
        // late, so the detour is only as long as the obstruction that caused it.
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
    /* THE COLUMNS ARE DICTATED TO DAGRE, as the one length each edge is allowed to have.
     *
     * `minlen` is dagre's floor on how many ranks an edge spans, and network simplex minimises the total edge
     * length subject to those floors. Set every floor to the distance the columns above already say the edge
     * covers and the depth ranking becomes the only assignment that meets them all at their floor, so it is the
     * one dagre returns, no ranker of its own choosing involved. Everything else it does is left alone: the order
     * WITHIN a column is still its crossing minimisation, which is the part worth having. */
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
    // The turns are measured off the PACKED boxes, not dagre's: a line has to leave the card where it now is.
    const boxes = new Map(placed.map((entry): [string, PlacedNode] => [entry.id, { ...entry, at: packed.get(entry.id) ?? entry.at }]));
    return { nodes: packed, lanes: turnPoints(edges, boxes, horizontal, rankSep, nodeSep) };
};

/* ONE EDGE AS A RIGHT-ANGLED PATH THROUGH ITS TURNS, with the corners rounded.
 *
 * Right angles rather than a curve because a layered graph is read as a flow: every line leaves its card
 * horizontally, changes row at a turn in the gap between two columns, and arrives horizontally. Parallel edges
 * then SHARE their horizontals instead of splaying into a dozen separate arcs, and a crossing reads as a
 * crossing. It is the shape every CI vendor's own graph uses, and the reason theirs look ordered at thirty jobs.
 *
 * `from` and `to` are the handle positions the renderer measured; `via` is the layout's turns (see
 * DagPlacement.lanes). With no turn given, one is taken in the middle, which is the classic elbow. */
export const lanePath = (from: DagPoint, to: DagPoint, via: readonly DagPoint[] = [], radius = 8): string => {
    const turns = via.length > 0 ? via : [{ x: (from.x + to.x) / 2, y: from.y }];

    // Horizontal first for every turn but the last, which turns vertical first so the line ARRIVES horizontal.
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
