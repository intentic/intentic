import type { ResourceView } from "@intentic-app/api-contract";

/* A tiny layered DAG layout for the desired-state dependency graph. Resources are placed in left→right layers
 * by dependency depth (a node sits one layer right of its deepest dependency), so edges always flow forward.
 * Pure + deterministic — the dependency-graph component renders the returned coordinates as plain HTML nodes
 * over an SVG edge layer. Kept dependency-free on purpose: the intent graphs are small, so a full layout
 * library (dagre) isn't warranted; this is the seam to swap one in if graphs ever grow. */

export interface GraphNode {
    readonly id: string;
    readonly resource: ResourceView;
    // Top-left position, in layout coordinates (before the component's padding offset).
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface GraphEdge {
    readonly from: string;
    readonly to: string;
    // [source-anchor, target-anchor] — right edge of the dependency, left edge of the dependent.
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
}

export interface GraphLayout {
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly GraphEdge[];
    readonly width: number;
    readonly height: number;
}

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 64;
const COLUMN_GAP = 88;
const ROW_GAP = 28;

export const layoutGraph = (resources: readonly ResourceView[]): GraphLayout => {
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    // Only edges to resources we actually have — drop dangling refs so layout never breaks on a missing dep.
    const depsOf = (id: string): readonly string[] => (byId.get(id)?.dependsOn ?? []).filter((dep) => byId.has(dep));

    // Layer = longest dependency chain to a root (no deps → layer 0). Cycle-guarded via the visiting stack.
    const layerById = new Map<string, number>();
    const layerOf = (id: string, visiting: Set<string>): number => {
        const cached = layerById.get(id);
        if (cached !== undefined) {
            return cached;
        }
        if (visiting.has(id)) {
            return 0;
        }
        visiting.add(id);
        const deps = depsOf(id);
        const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => layerOf(dep, visiting)));
        visiting.delete(id);
        layerById.set(id, layer);
        return layer;
    };
    for (const resource of resources) {
        layerOf(resource.id, new Set());
    }

    // Bucket resources by layer in their original order (stable, predictable rows).
    const layers: string[][] = [];
    for (const resource of resources) {
        const layer = layerById.get(resource.id) ?? 0;
        (layers[layer] ??= []).push(resource.id);
    }

    const nodes: GraphNode[] = [];
    const placed = new Map<string, GraphNode>();
    let maxRows = 0;
    layers.forEach((ids, layer) => {
        maxRows = Math.max(maxRows, ids.length);
        ids.forEach((id, row) => {
            const resource = byId.get(id);
            if (resource === undefined) {
                return;
            }
            const node: GraphNode = {
                id,
                resource,
                x: layer * (NODE_WIDTH + COLUMN_GAP),
                y: row * (NODE_HEIGHT + ROW_GAP),
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
            };
            nodes.push(node);
            placed.set(id, node);
        });
    });

    const edges: GraphEdge[] = [];
    for (const resource of resources) {
        for (const dep of depsOf(resource.id)) {
            const from = placed.get(dep);
            const to = placed.get(resource.id);
            if (from === undefined || to === undefined) {
                continue;
            }
            edges.push({
                from: dep,
                to: resource.id,
                start: { x: from.x + from.width, y: from.y + from.height / 2 },
                end: { x: to.x, y: to.y + to.height / 2 },
            });
        }
    }

    const width = Math.max(0, layers.length * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP);
    const height = Math.max(0, maxRows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP);
    return { nodes, edges, width, height };
};
