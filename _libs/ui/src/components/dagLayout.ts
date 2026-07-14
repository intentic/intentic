import { graphlib, layout } from "@dagrejs/dagre";

/* The DagGraph component's data model + its dagre layout step. Nodes carry an opaque `data` payload rendered
 * by the caller's #node slot; edges reference node ids. Layout is dagre's layered algorithm (LR by default),
 * which replaced the hand-rolled longest-chain layering this lib's consumers used before — dagre also breaks
 * cycles instead of needing a visiting guard. */

export interface DagNode<T = unknown> {
    readonly id: string;
    // Opaque payload handed to the #node slot.
    readonly data: T;
    // Native/PrimeVue tooltip content for the node's card (DagGraph owns the card wrapper, so the caller
    // can't attach a directive itself).
    readonly tooltip?: string;
    // Closure highlighting: fade this node without removing it from the layout.
    readonly dimmed?: boolean;
}

export interface DagEdge {
    // Rendered source → target: `from` sits left of `to` in LR layout, with the curve flowing forward.
    readonly from: string;
    readonly to: string;
    // Discriminator when two edges share endpoints (e.g. a prod and a dev dep) — part of the render key.
    readonly kind?: string;
    // e.g. dev deps.
    readonly dashed?: boolean;
    readonly dimmed?: boolean;
    // A text color class (e.g. `text-warning`) — the edge path strokes with currentColor at full opacity,
    // used to tint a selection's closure by direction.
    readonly accent?: string;
}

export interface DagLayoutOptions {
    readonly direction: `LR` | `TB`;
    readonly nodeWidth: number;
    readonly nodeHeight: number;
}

// Position every node with dagre (fixed sizes; edges to unknown ids are dropped so a dangling ref can't skew
// ranks). Returns top-left coordinates per node id — dagre yields centers.
export const layoutDag = (
    nodes: readonly DagNode<never>[],
    edges: readonly DagEdge[],
    options: DagLayoutOptions,
): Map<string, { x: number; y: number }> => {
    const graph = new graphlib.Graph();
    graph.setGraph({ rankdir: options.direction, nodesep: 28, ranksep: 88 });
    graph.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
        graph.setNode(node.id, { width: options.nodeWidth, height: options.nodeHeight });
    }
    for (const edge of edges) {
        if (ids.has(edge.from) && ids.has(edge.to)) {
            graph.setEdge(edge.from, edge.to);
        }
    }
    layout(graph);
    return new Map(
        nodes.map((node) => {
            const placed = graph.node(node.id);
            return [node.id, { x: placed.x - options.nodeWidth / 2, y: placed.y - options.nodeHeight / 2 }];
        }),
    );
};
