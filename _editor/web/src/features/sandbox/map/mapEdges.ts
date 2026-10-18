import { curve, elbow, entryOf, exitOf, type Flow, type Point, portsAlong, type Rect } from "./mapGeometry";
import type { MapLayout } from "./useMapLayout";
import type { Lighting } from "./reachLighting";
import type { GroupKey, PrincipalKind, ReachHow, ReachMap } from "./reachModel";

// THE MAP'S LINES, FROM WHERE ITS CARDS LANDED. Every way in runs to a door on the box's leading edge, one door per kind
// of principal; everything reached runs from a port on its trailing edge, one port per group, so each side reads as a
// few bundles rather than a tangle. A focus lights the lines it reaches, dashes the ones it reaches only through a
// persona, and draws threads from a focused node to what it is tied to. Pure: the layout is measured elsewhere.

export type EdgeState = `rest` | `on` | `off`;

export interface Edge {
    readonly key: string;
    readonly d: string;
    readonly kind: `entry` | `reach` | `thread`;
    readonly state: EdgeState;
    /** Reached only through something narrower (a persona, one conversation), or a way in not taken up yet. */
    readonly dashed: boolean;
    /** A way in that holds nothing now. */
    readonly faint: boolean;
}

export interface Socket {
    readonly key: string;
    readonly at: Point;
    readonly state: EdgeState;
}

export interface MapDrawing {
    readonly edges: readonly Edge[];
    readonly doors: readonly Socket[];
    readonly ports: readonly Socket[];
}

const KIND_ORDER: readonly PrincipalKind[] = [`person`, `token`, `link`];

// How far apart two doors (or two ports) sit on the box's edge, and how far from its corners.
const DOOR_GAP = 22;
const PORT_GAP = 16;

const middle = (rects: readonly Rect[], flow: Flow): number => {
    const low = Math.min(...rects.map((rect) => (flow === `across` ? rect.top : rect.left)));
    const high = Math.max(...rects.map((rect) => (flow === `across` ? rect.bottom : rect.right)));
    return (low + high) / 2;
};

// Points spread along one edge of the box, each as near its cluster as the edge allows.
const sockets = <K extends string>(clusters: readonly (readonly [K, readonly Rect[]])[], box: Rect, flow: Flow, side: `lead` | `trail`, gap: number): Map<K, Point> => {
    const along = portsAlong(
        clusters.map(([, rects]) => middle(rects, flow)),
        flow === `across` ? box.top : box.left,
        flow === `across` ? box.bottom : box.right,
        gap,
    );
    const edge = flow === `across` ? (side === `lead` ? box.left : box.right) : side === `lead` ? box.top : box.bottom;
    return new Map(clusters.map(([key], index) => [key, flow === `across` ? { x: edge, y: along[index] ?? 0 } : { x: along[index] ?? 0, y: edge }]));
};

const stateOf = (lit: boolean, focused: boolean): EdgeState => (!focused ? `rest` : lit ? `on` : `off`);

/** A thread between two cards wherever they sit: across the gap between them, or, side by side in one column, a loop
 *  out past their trailing edge and back. */
const threadPath = (from: Rect, to: Rect, flow: Flow): string => {
    const ahead = flow === `across` ? to.left >= from.right : to.top >= from.bottom;
    const behind = flow === `across` ? to.right <= from.left : to.bottom <= from.top;
    if (ahead) {
        return curve(exitOf(from, flow), entryOf(to, flow), flow);
    }
    if (behind) {
        return curve(exitOf(to, flow), entryOf(from, flow), flow);
    }
    const a = { x: from.right, y: (from.top + from.bottom) / 2 };
    const b = { x: to.right, y: (to.top + to.bottom) / 2 };
    const loop = 24 + Math.abs(b.y - a.y) / 4;
    const reach = Math.max(a.x, b.x) + loop;
    return `M${a.x} ${a.y} C${reach} ${a.y} ${reach} ${b.y} ${b.x} ${b.y}`;
};

const entryEdges = (layout: MapLayout, map: ReachMap, lighting: Lighting | undefined, doors: ReadonlyMap<PrincipalKind, Point>, lanes: ReadonlyMap<PrincipalKind, number>): Edge[] =>
    map.principals.flatMap((principal) => {
        const placed = layout.principals.get(principal.id);
        const door = doors.get(principal.kind);
        const lane = lanes.get(principal.kind);
        if (placed === undefined || door === undefined || lane === undefined) {
            return [];
        }
        const how = lighting?.principals.get(principal.id);
        return [
            {
                key: `entry:${principal.id}`,
                d: elbow(exitOf(placed.rect, `across`), door, lane),
                kind: `entry` as const,
                state: stateOf(how !== undefined, lighting !== undefined),
                dashed: how === `through` || principal.status === `invited`,
                faint: principal.status === `inert`,
            },
        ];
    });

// A folded group's row, or a whole group drawn as one block, stands in for every node it hides: lit when any of them is.
const hiddenHow = (map: ReachMap, layout: MapLayout, lighting: Lighting | undefined, group: GroupKey): ReachHow | `self` | `related` | undefined => {
    const nodes = map.groups.find((entry) => entry.key === group)?.nodes ?? [];
    for (const node of nodes) {
        const how = layout.nodes.has(node.id) ? undefined : lighting?.nodes.get(node.id);
        if (how !== undefined) {
            return how;
        }
    }
    return undefined;
};

const reachEdges = (layout: MapLayout, map: ReachMap, lighting: Lighting | undefined, ports: ReadonlyMap<GroupKey, Point>, lanes: ReadonlyMap<GroupKey, number>): Edge[] =>
    [...layout.nodes].flatMap(([id, placed]) => {
        const port = placed.group === undefined ? undefined : ports.get(placed.group);
        const lane = placed.group === undefined ? undefined : lanes.get(placed.group);
        if (port === undefined || lane === undefined || placed.group === undefined) {
            return [];
        }
        const how = id.startsWith(`bundle:`) ? (lighting?.nodes.get(id) ?? hiddenHow(map, layout, lighting, placed.group)) : lighting?.nodes.get(id);
        return [
            {
                key: `reach:${id}`,
                d: elbow(port, entryOf(placed.rect, `across`), lane),
                kind: `reach` as const,
                state: stateOf(how !== undefined, lighting !== undefined),
                dashed: how === `through`,
                faint: false,
            },
        ];
    });

const threadEdges = (layout: MapLayout, lighting: Lighting | undefined, focusId: string | undefined, flow: Flow): Edge[] => {
    const from = focusId === undefined ? undefined : layout.nodes.get(focusId);
    if (from === undefined || lighting === undefined) {
        return [];
    }
    return lighting.threads.flatMap((target) => {
        const to = layout.nodes.get(target);
        return to === undefined ? [] : [{ key: `thread:${target}`, d: threadPath(from.rect, to.rect, flow), kind: `thread` as const, state: `on` as const, dashed: false, faint: false }];
    });
};

// STACKED, ONE LINE EACH WAY. The clusters sit one under another there, and a line from each would run behind the ones
// below it: the whole column of ways in sends one trunk down into the box, and the box one trunk down to its groups,
// each lit when anything on its side is.
const union = (rects: readonly Rect[]): Rect => ({
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
});

interface Trunks {
    readonly edges: Edge[];
    readonly door: Point | undefined;
    readonly port: Point | undefined;
}

const trunks = (layout: MapLayout, map: ReachMap, lighting: Lighting | undefined, box: Rect): Trunks => {
    const focused = lighting !== undefined;
    const axis = (box.left + box.right) / 2;
    const principals = [...layout.principals.values()].map((placed) => placed.rect);
    const groups = [...layout.groups.values()];
    const door = principals.length === 0 ? undefined : { x: axis, y: box.top };
    const port = groups.length === 0 ? undefined : { x: axis, y: box.bottom };
    const inLit = map.principals.some((principal) => lighting?.principals.has(principal.id) === true);
    const outLit = map.groups.some((group) => group.nodes.some((node) => lighting?.nodes.has(node.id) === true));
    const edges: Edge[] = [];
    if (door !== undefined) {
        const from = { x: axis, y: union(principals).bottom };
        edges.push({ key: `trunk:in`, d: curve(from, door, `down`), kind: `entry`, state: stateOf(inLit, focused), dashed: false, faint: false });
    }
    if (port !== undefined) {
        const to = { x: axis, y: union(groups).top };
        edges.push({ key: `trunk:out`, d: curve(port, to, `down`), kind: `reach`, state: stateOf(outLit, focused), dashed: false, faint: false });
    }
    return { edges, door, port };
};

// ONE LANE PER CLUSTER. Lines bound for one cluster share a vertical lane in the gutter, and each cluster has its own, so two
// groups whose ports sit side by side on the box's corner never run down the same line. The cluster that travels farthest
// from its socket takes the lane nearest the box: its run then passes beside the shorter ones instead of across their
// turns, which keeps every lane free of crossings. Lanes stay a few pixels apart, closer when the gutter is narrow.
const LANE_GAP = 8;
const LANE_INSET = 6;

const lanesFor = <K extends string>(
    clusters: readonly (readonly [K, readonly Rect[]])[],
    anchors: ReadonlyMap<K, Point>,
    near: number,
    far: number,
): Map<K, number> => {
    const room = Math.abs(far - near) - 2 * LANE_INSET;
    const gap = clusters.length <= 1 ? 0 : Math.max(2, Math.min(LANE_GAP, room / (clusters.length - 1)));
    const away = Math.sign(far - near);
    const travel = (key: K, rects: readonly Rect[]): number => Math.abs(middle(rects, `across`) - (anchors.get(key)?.y ?? 0));
    const ranked = clusters.toSorted(([a, left], [b, right]) => travel(b, right) - travel(a, left));
    return new Map(ranked.map(([key], index) => [key, near + away * (LANE_INSET + index * gap)]));
};

const ORDER = { off: 0, rest: 1, on: 2 } as const satisfies Record<EdgeState, number>;

export const drawMap = (layout: MapLayout, map: ReachMap, lighting: Lighting | undefined, flow: Flow, focusId: string | undefined): MapDrawing => {
    const box = layout.box;
    if (box === undefined) {
        return { edges: [], doors: [], ports: [] };
    }
    const kinds = KIND_ORDER.flatMap((kind) => {
        const rects = [...layout.principals.values()].filter((placed) => placed.kind === kind).map((placed) => placed.rect);
        return rects.length === 0 ? [] : [[kind, rects] as const];
    });
    const groups = map.groups.flatMap((group) => {
        const rect = layout.groups.get(group.key);
        return rect === undefined ? [] : [[group.key, [rect]] as const];
    });
    const focused = lighting !== undefined;
    if (flow === `down`) {
        const stacked = trunks(layout, map, lighting, box);
        const socketAt = (at: Point | undefined, key: string, lit: boolean): Socket[] => (at === undefined ? [] : [{ key, at, state: stateOf(lit, focused) }]);
        return {
            edges: [...stacked.edges, ...threadEdges(layout, lighting, focusId, flow)],
            doors: socketAt(stacked.door, `door`, stacked.edges.some((edge) => edge.kind === `entry` && edge.state === `on`)),
            ports: socketAt(stacked.port, `port`, stacked.edges.some((edge) => edge.kind === `reach` && edge.state === `on`)),
        };
    }
    const doors = sockets(kinds, box, flow, `lead`, DOOR_GAP);
    const ports = sockets(groups, box, flow, `trail`, PORT_GAP);
    // Each side's lanes fill its gutter outward from the box: between the box and the principals' trailing edge, and
    // between the box and the groups' leading edge.
    const principalsEnd = Math.max(...kinds.flatMap(([, rects]) => rects.map((rect) => rect.right)), box.left - 48);
    const groupsStart = Math.min(...groups.flatMap(([, rects]) => rects.map((rect) => rect.left)), box.right + 48);
    const edges = [
        ...entryEdges(layout, map, lighting, doors, lanesFor(kinds, doors, box.left, principalsEnd)),
        ...reachEdges(layout, map, lighting, ports, lanesFor(groups, ports, box.right, groupsStart)),
        ...threadEdges(layout, lighting, focusId, flow),
    ];
    const doorLit = (kind: PrincipalKind): boolean => map.principals.some((principal) => principal.kind === kind && lighting?.principals.has(principal.id) === true);
    const portLit = (key: GroupKey): boolean =>
        map.groups.find((group) => group.key === key)?.nodes.some((node) => lighting?.nodes.has(node.id) === true) === true;
    return {
        // Lit lines last, so they are drawn over the dimmed ones they cross.
        edges: edges.toSorted((left, right) => ORDER[left.state] - ORDER[right.state]),
        doors: [...doors].map(([kind, at]) => ({ key: `door:${kind}`, at, state: stateOf(doorLit(kind), focused) })),
        ports: [...ports].map(([key, at]) => ({ key: `port:${key}`, at, state: stateOf(portLit(key), focused) })),
    };
};
