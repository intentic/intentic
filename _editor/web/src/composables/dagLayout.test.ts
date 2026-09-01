import { describe, expect, it } from "vitest";
import { type DagEdge, type DagNode, type DagPlacement, laneKey, lanePath, layoutDag, layoutSignature } from "@intentic/ui/dag";

/* DagGraph refits its viewport when this signature changes. It lives here rather than in @intentic/ui because
 * the design system ships no test runner (same reason as figures.test.ts).
 *
 * The bug it exists for: the refit watcher used to key on the node COUNT. A count is not an identity, so two
 * different graphs of the same size looked identical to the watcher, and a caller that renders one DagGraph per
 * document page (keyed by position, so Vue patches rather than remounts) carried the previous page's pan and zoom
 * onto the next graph. Worst when a 2-node graph came first: its fit had clamped to maxZoom, so the next page
 * rendered at 2×. Every case below is one way two graphs can differ without differing in length. */

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
        // The whole bug in one assertion: `length` cannot tell these apart, so no refit happened between them.
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`c`), node(`d`)]));
    });

    it(`distinguishes the same nodes wired differently`, () => {
        // Same nodes, same count, but dagre puts them in different places, so the fit must change.
        expect(sig([node(`a`), node(`b`)], [edge(`a`, `b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`b`, `a`)]));
    });

    it(`distinguishes a graph with no edges from a connected one`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`a`), node(`b`)], [edge(`a`, `b`)]));
    });

    it(`notices node order, which dagre lays out from`, () => {
        expect(sig([node(`a`), node(`b`)])).not.toBe(sig([node(`b`), node(`a`)]));
    });

    /* The spacing is a layout input like the box is: a run's card is a list of rows and asks for a tighter pair
     * than a note's map, and changing it moves every node in the picture, so a fit measured under the old one is
     * the wrong fit. Restating the default cannot move anything and must not read as a different graph. */
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

    /* A node may override the caller's box: a pipeline card is as tall as the jobs it lists. That override is a
     * layout input like any other, the same ids at a new height re-rank the whole column, so it belongs in the
     * signature; an override that merely restates the default cannot move anything and must not. */
    it(`notices a per-node box override, and ignores one that restates the default`, () => {
        const tall: DagNode<undefined> = { id: `a`, data: undefined, height: 128 };
        expect(sig([node(`a`)])).not.toBe(sig([tall]));
        expect(sig([{ id: `a`, data: undefined, height: options.nodeHeight }])).toBe(sig([node(`a`)]));
    });

    it(`still changes when the count changes, which is what it replaced`, () => {
        expect(sig([node(`a`)])).not.toBe(sig([node(`a`), node(`b`)]));
    });

    /* Labels are deliberately NOT in it. Re-rendering the same shape with new text must not discard a pan the
     * user chose: the viewport is theirs once they touch it, and only a different graph may take it back. */
    it(`ignores everything that cannot move a node`, () => {
        const plain: DagNode<undefined> = { id: `a`, data: undefined };
        const dressed: DagNode<undefined> = { id: `a`, data: undefined, tooltip: `hello`, dimmed: true };
        expect(sig([plain])).toBe(sig([dressed]));
    });
});

/* WHICH COLUMN A NODE LANDS IN, AND WHERE IN IT. Both are corrections to what dagre answers on its own, and
 * both are what the CI job graph was reported unreadable over. dagre ranks to keep the total edge length short
 * and spreads a rank out to straighten the lines; the first drifts a root rightwards under the jobs it feeds,
 * the second turns 500px of content into a 944px picture. */
describe(`layoutDag`, () => {
    const place = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[]): DagPlacement =>
        layoutDag(nodes as readonly DagNode<never>[], edges, options);
    const columnOf = (placed: DagPlacement, id: string): number => Math.round(placed.nodes.get(id)?.x ?? Number.NaN);
    const topOf = (placed: DagPlacement, id: string): number => Math.round(placed.nodes.get(id)?.y ?? Number.NaN);

    it(`puts a root in the first column even when everything it feeds is far to the right`, () => {
        // `b` waits for nothing, so it belongs beside `a`. Network simplex would rather move it one column right,
        // where its only edge is one rank long instead of two, and on this workspace's own CI run that is what
        // drew `preflight` a column right of `changes`: a root reading as though it waited for another job.
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
        // `dead` and `feeder` share a column and only `feeder` leads anywhere, so it takes the top and the flow
        // reads along it. dagre's own crossing minimisation is indifferent here and on the workspace's CI run
        // answered the other way round, which left the run's dead ends sitting in the middle of its spine.
        const placed = place(
            [node(`root`), node(`dead`), node(`feeder`), node(`tail`)],
            [edge(`root`, `dead`), edge(`root`, `feeder`), edge(`feeder`, `tail`)],
        );
        expect(columnOf(placed, `dead`)).toBe(columnOf(placed, `feeder`));
        expect(topOf(placed, `feeder`)).toBeLessThan(topOf(placed, `dead`));
    });

    it(`keeps two parallel chains from crossing each other`, () => {
        const placed = place([node(`a1`), node(`b1`), node(`a2`), node(`b2`)], [edge(`a1`, `a2`), edge(`b1`, `b2`)]);
        // Whichever chain takes the top of the first column takes the top of the second: a crossing here would
        // be two lines drawn through each other for no reason at all.
        const aOnTop = topOf(placed, `a1`) < topOf(placed, `b1`);
        expect(topOf(placed, `a2`) < topOf(placed, `b2`)).toBe(aOnTop);
    });

    /* AN EDGE KEEPS ITS SOURCE'S ROW AND TURNS ONCE, AT THE END. Every line out of one card then starts on the
     * same row and they overlap into a single stroke that peels apart near its targets, which is what a fan-out
     * is supposed to look like. Turning early instead ran the line at the TARGET's row, so an edge to a card at
     * the top of the picture hauled a stroke up and across the whole diagram, far from either of its ends. */
    it(`keeps its source's row and turns once, in the gutter before its target`, () => {
        const placed = place([node(`a`), node(`b`), node(`c`)], [edge(`a`, `b`), edge(`b`, `c`), edge(`a`, `c`)]);
        const turns = placed.lanes.get(laneKey(`a`, `c`)) ?? [];
        expect(turns).toHaveLength(1);
        // On `a`'s row, not `c`'s, and in the last gutter: past `b`'s column rather than before it.
        expect(turns[0]?.y).toBe(topOf(placed, `a`) + options.nodeHeight / 2);
        expect(turns[0]?.x).toBeGreaterThan(columnOf(placed, `b`) + options.nodeWidth);
    });

    /* A LINE THAT ENTERS A CARD AND LEAVES THE OTHER SIDE READS AS GOING THROUGH IT, whatever the z-order says
     * (the cards paint on top, so it is really passing behind). Nineteen of forty edges on this workspace's own
     * CI run walked across a card's face. Where its own row is blocked, an edge takes a lane instead: out into
     * it early, along it, back out of it late, so the detour is only as long as the obstruction. */
    it(`steps around a card standing on its row, and back onto it after`, () => {
        // Two cards in the middle column leave a gap between them; `a` and the first of them share a row.
        const placed = place([node(`a`), node(`b1`), node(`b2`), node(`d`)], [edge(`a`, `b1`), edge(`a`, `b2`), edge(`a`, `d`), edge(`b1`, `d`)]);
        const turns = placed.lanes.get(laneKey(`a`, `d`)) ?? [];
        expect(turns).toHaveLength(2);
        const clear = (point: { readonly y: number }): boolean =>
            [`b1`, `b2`].every((id) => point.y <= topOf(placed, id) || point.y >= topOf(placed, id) + options.nodeHeight);
        expect(turns.every(clear)).toBe(true);
        // And the lane is INSIDE the picture: sailing above the topmost card is always free and always wrong.
        expect(turns.every((point) => point.y > topOf(placed, `b1`))).toBe(true);
    });

    it(`still turns once for a hop to the next column, which has nothing to avoid`, () => {
        const placed = place([node(`a`), node(`b`)], [edge(`a`, `b`)]);
        expect(placed.lanes.get(laneKey(`a`, `b`))).toHaveLength(1);
    });

    it(`still lays out a graph with a cycle in it`, () => {
        // Depth is undefined round a ring, so the first node the ring would leave unplaced is cut loose and
        // placed from whatever of its dependencies did resolve. What must not happen is nothing being placed.
        const placed = place([node(`a`), node(`b`), node(`c`), node(`d`)], [edge(`a`, `b`), edge(`b`, `c`), edge(`c`, `a`), edge(`c`, `d`)]);
        expect(columnOf(placed, `a`)).toBeLessThan(columnOf(placed, `b`));
        expect(columnOf(placed, `b`)).toBeLessThan(columnOf(placed, `c`));
        expect(columnOf(placed, `c`)).toBeLessThan(columnOf(placed, `d`));
    });
});

/* The edge shape a layered graph is read with: horizontal out, one turn in a gap dagre left free, horizontal
 * in. What it exists for is the TURN'S X, which comes from dagre's own routing: re-deriving a path from its two
 * endpoints (what every built-in shape does) draws an edge that spans three ranks straight over whatever card
 * sits in the middle, and on the workspace's own CI run that was a dozen lines crossing a card. */
describe(`lanePath`, () => {
    // The corners a path visits, as `x,y`, read back off the commands: `M`/`L` end on one, `Q` bends around one.
    const corners = (path: string): string[] => [...path.matchAll(/(?:M|L|Q) (-?[\d.]+) (-?[\d.]+)/gu)].map(([, x, y]) => `${x},${y}`);

    it(`turns where the layout said, not at the midpoint between the two ends`, () => {
        // The layout turns in the first gap after the source, so a line spanning four columns drops to its
        // target's row immediately and then runs straight, rather than bending across the middle of the picture.
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
