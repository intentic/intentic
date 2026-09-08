import { describe, expect, it } from "vitest";
import { type DagEdge, type DagNode, type DagPlacement, laneKey, lanePath, layoutDag, layoutSignature } from "@intentic/ui/dag";

// DagGraph refits its viewport when this signature changes; lives here because @intentic/ui ships no test runner. Each
// case below is a way two graphs can differ without differing in node count, since a count is not an identity.

const node = (id: string): DagNode<undefined> => ({ id, data: undefined });
const edge = (from: string, to: string): DagEdge => ({ from, to });
const options = { direction: `LR` as const, nodeWidth: 208, nodeHeight: 64 };
const sig = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[] = [], overrides = {}) =>
    layoutSignature(nodes as readonly DagNode<never>[], edges, { ...options, ...overrides });

describe(`layoutSignature`, () => {
    it(`is stable for the same graph`, () => {
        expect(sig([node(`a`), node(`b`)], [edge(`a`, `b`)])).toBe(sig([node(`a`), node(`b`)], [edge(`a`, `b`)]));
    });

    it(`distinguishes two graphs with the SAME node count`, () => {
        // `length` alone cannot tell these two graphs apart.
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`c`), node(`d`)]));
    });

    it(`distinguishes the same nodes wired differently`, () => {
        // Same nodes and count, wired differently, so the fit must change.
        expect(sig([node(`a`), node(`b`)], [edge(`a`, `b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`b`, `a`)]));
    });

    it(`distinguishes a graph with no edges from a connected one`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`a`, `b`)]));
    });

    it(`notices node order, which dagre lays out from`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`b`), node(`a`)]));
    });

    // Spacing is a layout input: changing it moves every node, so the fit must change with it. Restating the default
    // must not, since nothing moved.
    it(`notices the spacing, and ignores a restatement of the default`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`a`), node(`b`)], [], { nodeSep: 14 }));
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`a`), node(`b`)], [], { rankSep: 56 }));
        expect(sig([node(`a`)], [], { rankSep: 88, nodeSep: 28 })).toBe(sig([node(`a`)]));
    });

    it(`notices direction and the node box`, () => {
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { direction: `TB` }));
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { nodeHeight: 56 }));
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`)], [], { nodeWidth: 240 }));
    });

    // A per-node box override re-ranks its column like any layout input, so it belongs in the signature. One that
    // restates the default must not change it.
    it(`notices a per-node box override, and ignores one that restates the default`, () => {
        const tall: DagNode<undefined> = { id: `a`, data: undefined, height: 128 };
        expect(sig([node(`a`)])).not.toBe(sig([tall]));
        expect(sig([{ id: `a`, data: undefined, height: options.nodeHeight }])).toBe(sig([node(`a`)]));
    });

    it(`still changes when the count changes, which is what it replaced`, () => {
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`), node(`b`)]));
    });

    // Labels are not part of the signature: re-rendering the same shape with new text must not discard a pan the reader
    // chose.
    it(`ignores everything that cannot move a node`, () => {
        const plain: DagNode<undefined> = { id: `a`, data: undefined };
        const dressed: DagNode<undefined> = { id: `a`, data: undefined, tooltip: `hello`, dimmed: true };
        expect(sig([plain])).toBe(sig([dressed]));
    });
});

// Corrects two things dagre gets wrong on its own: it drifts a root rightward under the jobs it feeds, and it spreads a
// rank enough to inflate a diagram's width unnecessarily.
describe(`layoutDag`, () => {
    const place = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[]): DagPlacement =>
        layoutDag(nodes as readonly DagNode<never>[], edges, options);
    const columnOf = (placed: DagPlacement, id: string): number => Math.round(placed.nodes.get(id)?.x ?? Number.NaN);
    const topOf = (placed: DagPlacement, id: string): number => Math.round(placed.nodes.get(id)?.y ?? Number.NaN);

    it(`puts a root in the first column even when everything it feeds is far to the right`, () => {
        // `b` waits for nothing, so it belongs beside `a`; network simplex would rather shift it one column right,
        // shortening its own edge at the cost of misplacing it.
        const placed = place([node(`a`), node(`b`), node(`c`), node(`d`)], [edge(`a`, `c`), edge(`c`, `d`), edge(`b`, `d`)]);
        expect(columnOf(placed, `b`)).toBe(columnOf(placed, `a`));
        expect(columnOf(placed, `c`)).toBeGreaterThan(columnOf(placed, `a`));
        expect(columnOf(placed, `d`)).toBeGreaterThan(columnOf(placed, `c`));
    });

    it(`starts every column at the same top, and never overlaps two cards in one`, () => {
        const placed = place([node(`a`), node(`b`), node(`c`), node(`d`)], [edge(`a`, `b`), edge(`a`, `c`), edge(`a`, `d`)]);
        const columns = new Map<number, string[]>();
        for (const id of [`a`, `b`, `c`, `d`]) {
            const column = columnOf(placed, id);
            columns.set(column, [...(columns.get(column) ?? []), id]);
        }
        expect(columns.size).toBe(2);
        for (const members of columns.values()) {
            const tops = members.map((id) => topOf(placed, id)).toSorted((one, other) => one - other);
            expect(tops[0]).toBe(0);
            // Consecutive cards are at least a card apart, so a column is a stack rather than a pile.
            for (const [index, top] of tops.slice(1).entries()) {
                expect(top - (tops[index] ?? 0)).toBeGreaterThanOrEqual(options.nodeHeight);
            }
        }
    });

    it(`puts the card whose line continues above the one nothing waits on`, () => {
        // `dead` and `feeder` share a column; only `feeder` leads anywhere, so it takes the top and the flow reads
        // along it. dagre's own crossing minimisation does not guarantee this on its own.
        const placed = place(
            [node(`root`), node(`dead`), node(`feeder`), node(`tail`)],
            [edge(`root`, `dead`), edge(`root`, `feeder`), edge(`feeder`, `tail`)],
        );
        expect(columnOf(placed, `dead`)).toBe(columnOf(placed, `feeder`));
        expect(topOf(placed, `feeder`)).toBeLessThan(topOf(placed, `dead`));
    });

    it(`keeps two parallel chains from crossing each other`, () => {
        const placed = place([node(`a1`), node(`b1`), node(`a2`), node(`b2`)], [edge(`a1`, `a2`), edge(`b1`, `b2`)]);
        // Whichever chain takes the top of the first column takes the top of the second, or the two lines would cross
        // needlessly.
        const aOnTop = topOf(placed, `a1`) < topOf(placed, `b1`);
        expect(topOf(placed, `a2`) < topOf(placed, `b2`)).toBe(aOnTop);
    });

    // An edge keeps its source's row and turns once, at the end, so a fan-out's lines overlap into one stroke near the
    // source and peel apart near their targets. Turning at the target's row instead would run the stroke across the
    // whole diagram.
    it(`keeps its source's row and turns once, in the gutter before its target`, () => {
        const placed = place([node(`a`), node(`b`), node(`c`)], [edge(`a`, `b`), edge(`b`, `c`), edge(`a`, `c`)]);
        const turns = placed.lanes.get(laneKey(`a`, `c`)) ?? [];
        expect(turns).toHaveLength(1);
        // On `a`'s row, not `c`'s, and in the last gutter, past `b`'s column.
        expect(turns[0]?.y).toBe(topOf(placed, `a`) + options.nodeHeight / 2);
        expect(turns[0]?.x).toBeGreaterThan(columnOf(placed, `b`) + options.nodeWidth);
    });

    // A line crossing a card's face reads as going through it, whatever the z-order says. Where its row is blocked, an
    // edge steps into a lane early and back out late, keeping the detour as short as the obstruction.
    it(`steps around a card standing on its row, and back onto it after`, () => {
        // Two cards in the middle column leave a gap between them; `a` and the first of them share a row.
        const placed = place([node(`a`), node(`b1`), node(`b2`), node(`d`)], [edge(`a`, `b1`), edge(`a`, `b2`), edge(`a`, `d`), edge(`b1`, `d`)]);
        const turns = placed.lanes.get(laneKey(`a`, `d`)) ?? [];
        expect(turns).toHaveLength(2);
        const clear = (point: { readonly y: number }): boolean =>
            [`b1`, `b2`].every((id) => point.y <= topOf(placed, id) || point.y >= topOf(placed, id) + options.nodeHeight);
        expect(turns.every(clear)).toBe(true);
        // The lane stays inside the picture; routing above the topmost card would be free but wrong.
        expect(turns.every((point) => point.y > topOf(placed, `b1`))).toBe(true);
    });

    it(`still turns once for a hop to the next column, which has nothing to avoid`, () => {
        const placed = place([node(`a`), node(`b`)], [edge(`a`, `b`)]);
        expect(placed.lanes.get(laneKey(`a`, `b`))).toHaveLength(1);
    });

    it(`still lays out a graph with a cycle in it`, () => {
        // Depth is undefined around a cycle, so the node it would leave unplaced is cut loose and placed from whatever
        // dependency did resolve. What must not happen is nothing being placed.
        const placed = place([node(`a`), node(`b`), node(`c`), node(`d`)], [edge(`a`, `b`), edge(`b`, `c`), edge(`c`, `a`), edge(`c`, `d`)]);
        expect(columnOf(placed, `a`)).toBeLessThan(columnOf(placed, `b`));
        expect(columnOf(placed, `b`)).toBeLessThan(columnOf(placed, `c`));
        expect(columnOf(placed, `c`)).toBeLessThan(columnOf(placed, `d`));
    });
});

// The edge shape a layered graph is read with: horizontal out, one turn in a gap dagre left free, horizontal in. The
// turn's x comes from dagre's own routing; deriving a path from just the two endpoints instead draws it straight over
// whatever card sits between them.
describe(`lanePath`, () => {
    // The corners a path visits, as `x,y`: `M`/`L` end on one, `Q` bends around one.
    const corners = (path: string): string[] => [...path.matchAll(/(?:M|L|Q) (-?[\d.]+) (-?[\d.]+)/gu)].map(([, x, y]) => `${x},${y}`);

    it(`turns where the layout said, not at the midpoint between the two ends`, () => {
        // The layout turns in the first gap after the source, so a long span drops to the target's row immediately
        // rather than bending mid-picture.
        const path = lanePath({ x: 0, y: 0 }, { x: 600, y: 100 }, [{ x: 120, y: 0 }]);
        expect(corners(path)).toContain(`120,0`);
        expect(corners(path)).toContain(`120,100`);
        expect(corners(path).some((corner) => corner.startsWith(`300,`))).toBe(false);
    });

    it(`turns in the middle when it is given no turn`, () => {
        const path = lanePath({ x: 0, y: 0 }, { x: 600, y: 100 }, []);
        expect(corners(path)).toContain(`300,0`);
        expect(corners(path)).toContain(`300,100`);
    });

    it(`leaves and arrives horizontally, which is what makes a column read as a column`, () => {
        const path = lanePath({ x: 0, y: 0 }, { x: 600, y: 100 }, []);
        const visited = corners(path);
        const [first, second] = visited;
        const last = visited.at(-1);
        const penultimate = visited.at(-2);
        expect(first?.split(`,`)[1]).toBe(second?.split(`,`)[1]);
        expect(last?.split(`,`)[1]).toBe(penultimate?.split(`,`)[1]);
    });

    it(`draws a straight line straight, with no bend to round`, () => {
        const path = lanePath({ x: 0, y: 50 }, { x: 600, y: 50 }, []);
        expect(path).toBe(`M 0 50 L 600 50`);
    });

    it(`rounds every bend it does draw`, () => {
        const path = lanePath({ x: 0, y: 0 }, { x: 600, y: 100 }, []);
        expect((path.match(/Q/gu) ?? []).length).toBe(2);
    });
});
