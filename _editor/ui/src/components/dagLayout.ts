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
}

/* WHICH GRAPH IS ON SCREEN, everything that decides where the nodes end up, as one comparable string.
 *
 * DagGraph refits its viewport when this changes. It used to watch the node COUNT instead, which is not an
 * identity: two different six-node graphs share a count, so navigating between them left the previous graph's
 * pan and zoom applied to the new one. Where that bit hardest was a small graph followed by a large one, the
 * small one's fit had clamped to maxZoom, and the large one then rendered at 2×, which reads as "zoomed in way
 * too much" rather than as a stale transform.
 *
 * It stays a string rather than a structural compare because a watcher needs a cheap, stable value, and it
 * covers exactly the layout inputs: ids and their order, the edges between them, the direction, and the fixed
 * node box. Node LABELS are deliberately absent, re-rendering the same shape with new text must not throw
 * away a pan the user chose. */
export const layoutSignature = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[], options: DagLayoutOptions): string =>
    [
        options.direction,
        options.nodeWidth,
        options.nodeHeight,
        nodes.map((node) => node.id).join(`,`),
        edges.map((edge) => `${edge.from}>${edge.to}`).join(`,`),
    ].join(`|`);

// Position every node with dagre (fixed sizes; edges to unknown ids are dropped so a dangling ref can't skew
// ranks). Returns top-left coordinates per node id, dagre yields centers.
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
