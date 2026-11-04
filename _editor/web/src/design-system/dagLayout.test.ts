import { type DagEdge, type DagNode, type DagPlacement, laneKey, lanePath, layoutDag, layoutSignature, smoothPath } from "@intentic/ui/dag";

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

    // DagGraph keeps its placement for as long as the signature holds, so what only draws must neither enter the
    // signature nor move anything: a selection dims half the graph on every click.
    it(`ignores what only draws, which places nothing differently`, () => {
        const plain = { nodes: [node(`a`), node(`b`)], edges: [edge(`a`, `b`)] };
        const drawn = {
            nodes: [{ ...node(`a`), dimmed: true, tooltip: `a tip` }, node(`b`)],
            edges: [{ ...edge(`a`, `b`), dimmed: true, dashed: true, accent: `text-warning`, kind: `dev` }],
        };
        expect(sig(drawn.nodes, drawn.edges)).toBe(sig(plain.nodes, plain.edges));
        const place = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[]) =>
            layoutDag(nodes as readonly DagNode<never>[], edges, options);
        expect(place(drawn.nodes, drawn.edges)).toEqual(place(plain.nodes, plain.edges));
    });

    it(`notices a caller-fixed order, which moves cards within their column`, () => {
        expect(
            sig([
                { ...node(`a`), order: 0 },
                { ...node(`b`), order: 1 },
            ]),
        ).not.toBe(
            sig([
                { ...node(`a`), order: 1 },
                { ...node(`b`), order: 0 },
            ]),
        );
    });

    it(`notices a card moved onto another line of its column`, () => {
        const ordered = { ...node(`a`), order: 0 };
        expect(sig([ordered])).not.toBe(sig([{ ...ordered, line: 1 }]));
        expect(sig([ordered])).toBe(sig([{ ...ordered, line: 0 }]));
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
    const placeDown = (nodes: readonly DagNode<undefined>[], edges: readonly DagEdge[]): DagPlacement =>
        layoutDag(nodes as readonly DagNode<never>[], edges, { ...options, direction: `TB` });
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
        // `z` leads to `b`, so it takes the top of the first column and `a` the row below, which nothing stands on.
        const placed = place([node(`a`), node(`z`), node(`b`), node(`c`)], [edge(`z`, `b`), edge(`b`, `c`), edge(`a`, `c`)]);
        expect(topOf(placed, `a`)).toBeGreaterThan(topOf(placed, `b`));
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

    // A forge draws a run its own way; a caller reproducing that picture fixes every card's place, and the layout keeps
    // it exactly, even where its own pass would have chosen otherwise.
    it(`stacks each column in the caller's order when every node carries one`, () => {
        const ordered = (id: string, order: number): DagNode<undefined> => ({ ...node(id), order });
        // `dead` above `feeder` is the opposite of what the layout's own pass picks (see above).
        const placed = place(
            [ordered(`root`, 0), ordered(`dead`, 0), ordered(`feeder`, 1), ordered(`tail`, 0)],
            [edge(`root`, `dead`), edge(`root`, `feeder`), edge(`feeder`, `tail`)],
        );
        expect(topOf(placed, `dead`)).toBe(0);
        expect(topOf(placed, `feeder`)).toBe(options.nodeHeight + 28);
        // Columns are still dependency depth, one card's width and one gap apart.
        expect(columnOf(placed, `root`)).toBe(0);
        expect(columnOf(placed, `feeder`)).toBe(options.nodeWidth + 88);
        expect(columnOf(placed, `tail`)).toBe(2 * (options.nodeWidth + 88));
    });

    // Top to bottom a rank is a row: a tall card hangs down from the row's top edge rather than pushing its neighbours
    // to its middle, and a narrow row sits centred under a wide one, as a downward flow reads.
    it(`starts a row's cards at one top edge and centres each row on the widest`, () => {
        const ordered = (id: string, order: number, height = options.nodeHeight): DagNode<undefined> => ({ ...node(id), order, height });
        const placed = placeDown(
            [ordered(`root`, 0), ordered(`short`, 0), ordered(`tall`, 1, 200), ordered(`tail`, 0)],
            [edge(`root`, `short`), edge(`root`, `tall`), edge(`short`, `tail`)],
        );
        expect(topOf(placed, `short`)).toBe(topOf(placed, `tall`));
        // The second row is two cards and a gap wide; the first and last are one card, centred under it.
        const wide = 2 * options.nodeWidth + 28;
        expect(columnOf(placed, `short`)).toBe(0);
        expect(columnOf(placed, `root`)).toBe(Math.round((wide - options.nodeWidth) / 2));
        expect(columnOf(placed, `tail`)).toBe(columnOf(placed, `root`));
        // The next row starts below the tallest card of the one above it, not the first.
        expect(topOf(placed, `tail`)).toBe(topOf(placed, `tall`) + 200 + 88);
    });

    // A turn taken at a short card's own edge would run across the taller card beside it in its row.
    it(`turns below the whole row, not just below its own card`, () => {
        const sized = (id: string, order: number, box: { height?: number; width?: number } = {}): DagNode<undefined> => ({ ...node(id), order, ...box });
        // `b1` is wide enough to stand under `a`, so the line from `a` to `d` has to step sideways before it drops.
        const placed = placeDown(
            [sized(`a`, 0), sized(`tall`, 1, { height: 240 }), sized(`b1`, 0, { width: 400 }), sized(`b2`, 1), sized(`d`, 0)],
            [edge(`a`, `b1`), edge(`tall`, `b2`), edge(`a`, `d`), edge(`b1`, `d`), edge(`b2`, `d`)],
        );
        const turns = placed.lanes.get(laneKey(`a`, `d`)) ?? [];
        expect(turns).toHaveLength(2);
        expect(turns.every((point) => point.y > topOf(placed, `tall`) + 240)).toBe(true);
    });

    // A stage too wide for the frame wraps: the caller puts its cards on lines, and each line is drawn as a rank of its
    // own, a gutter below the one before it and centred like any row, so the next stage starts below the last line.
    it(`draws each line of a wrapped column as a row of its own`, () => {
        const card = (id: string, order: number, line = 0): DagNode<undefined> => ({ ...node(id), order, line });
        const placed = placeDown(
            [card(`root`, 0), card(`a`, 0), card(`b`, 1), card(`c`, 2, 1), card(`tail`, 0)],
            [edge(`root`, `a`), edge(`root`, `b`), edge(`root`, `c`), edge(`a`, `tail`)],
        );
        const rowGap = options.nodeHeight + 88;
        expect(topOf(placed, `a`)).toBe(rowGap);
        expect(topOf(placed, `b`)).toBe(rowGap);
        expect(topOf(placed, `c`)).toBe(2 * rowGap);
        expect(topOf(placed, `tail`)).toBe(3 * rowGap);
        // The second line is one card, centred under the two of the first.
        expect(columnOf(placed, `c`)).toBe(Math.round((2 * options.nodeWidth + 28 - options.nodeWidth) / 2));
    });

    // Under a wrapped row no lane lines up from one line's gaps to the next one's, and a line drawn through a card
    // reads as going through it: it goes round the picture's nearer side instead.
    it(`goes round the side of the picture when every lane inside it is blocked`, () => {
        const card = (id: string, order: number, line = 0, width = options.nodeWidth): DagNode<undefined> => ({ ...node(id), order, line, width });
        // `wide` spans the whole picture under `a`, so nothing between the two can carry a line from `a` to `d`.
        const placed = placeDown(
            [card(`a`, 0), card(`b1`, 0), card(`b2`, 1), card(`wide`, 2, 1, 2 * options.nodeWidth + 28), card(`d`, 0)],
            [edge(`a`, `b1`), edge(`a`, `b2`), edge(`a`, `wide`), edge(`b1`, `d`), edge(`a`, `d`)],
        );
        const turns = placed.lanes.get(laneKey(`a`, `d`)) ?? [];
        expect(turns).toHaveLength(2);
        const left = Math.min(...[`b1`, `b2`, `wide`].map((id) => columnOf(placed, id)));
        const right = Math.max(...[`b1`, `b2`].map((id) => columnOf(placed, id) + options.nodeWidth));
        expect(turns.every((point) => point.x < left || point.x > right)).toBe(true);
    });

    it(`ignores an order only some nodes carry, rather than half-applying it`, () => {
        const nodes = [node(`root`), { ...node(`dead`), order: 1 }, { ...node(`feeder`), order: 0 }, node(`tail`)];
        const edges = [edge(`root`, `dead`), edge(`root`, `feeder`), edge(`feeder`, `tail`)];
        expect(place(nodes, edges)).toEqual(place([node(`root`), node(`dead`), node(`feeder`), node(`tail`)], edges));
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

    // A top-to-bottom graph is read down its rows: the same path turned on its side.
    it(`leaves and arrives vertically when the graph runs top to bottom`, () => {
        const path = lanePath({ x: 0, y: 0 }, { x: 100, y: 600 }, [{ x: 0, y: 480 }], 8, `TB`);
        const visited = corners(path);
        const [first, second] = visited;
        const last = visited.at(-1);
        const penultimate = visited.at(-2);
        expect(first?.split(`,`)[0]).toBe(second?.split(`,`)[0]);
        expect(last?.split(`,`)[0]).toBe(penultimate?.split(`,`)[0]);
        // The turn is where the layout put it: in the gutter above the target, not along the target's top edge.
        expect(visited).toContain(`0,480`);
        expect(visited).toContain(`100,480`);
    });

    it(`rounds every bend it does draw`, () => {
        const path = lanePath({ x: 0, y: 0 }, { x: 600, y: 100 }, []);
        expect((path.match(/Q/gu) ?? []).length).toBe(2);
    });
});

// The same route as lanePath with no corner on it: where the line changes lane it sweeps across the gutter in one
// S-curve, so it leaves its card and enters the next along the flow, and a fan-out opens from one point.
describe(`smoothPath`, () => {
    it(`sweeps across the gutter it turns in, from its source's edge to its target's`, () => {
        // One turn, at the middle of an 80px gutter between x 100 and 180.
        const path = smoothPath({ x: 0, y: 0 }, { x: 300, y: 100 }, [{ x: 140, y: 0 }], 80);
        expect(path).toBe(`M 0 0 L 100 0 C 140 0 140 100 180 100 L 300 100`);
    });

    it(`leaves and arrives along the flow, which is what makes the curve read as one line`, () => {
        const path = smoothPath({ x: 0, y: 0 }, { x: 300, y: 100 }, [{ x: 140, y: 0 }], 80);
        const [, curve] = /C (.+?) L/u.exec(path) ?? [];
        const [c1y, , c2y] = (curve ?? ``).split(` `).filter((_, index) => index % 2 === 1);
        // Both control points share the along coordinate of the turn: the tangents at both ends run with the flow.
        expect(c1y).toBe(`0`);
        expect(c2y).toBe(`100`);
    });

    it(`takes a detour as two sweeps with a straight run between them`, () => {
        const path = smoothPath({ x: 0, y: 0 }, { x: 600, y: 0 }, [
            { x: 140, y: 200 },
            { x: 460, y: 200 },
        ], 80);
        expect(path).toBe(`M 0 0 L 100 0 C 140 0 140 200 180 200 L 420 200 C 460 200 460 0 500 0 L 600 0`);
    });

    it(`draws a straight line straight`, () => {
        expect(smoothPath({ x: 0, y: 50 }, { x: 600, y: 50 }, [])).toBe(`M 0 50 L 600 50`);
    });

    it(`never sweeps back past its own source when the gutter is wider than the room`, () => {
        // The turn sits 20px past the source: the sweep is 40px long rather than the gutter's 80.
        expect(smoothPath({ x: 0, y: 0 }, { x: 300, y: 100 }, [{ x: 20, y: 0 }], 80)).toBe(`M 0 0 C 20 0 20 100 40 100 L 300 100`);
    });

    // A top-to-bottom graph is read down its rows: the same path turned on its side.
    it(`leaves and arrives vertically when the graph runs top to bottom`, () => {
        const path = smoothPath({ x: 0, y: 0 }, { x: 100, y: 300 }, [{ x: 0, y: 140 }], 80, `TB`);
        expect(path).toBe(`M 0 0 L 0 100 C 0 140 100 140 100 180 L 100 300`);
    });
});
