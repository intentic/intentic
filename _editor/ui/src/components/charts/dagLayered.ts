import type { DagEdge, DagLayoutOptions, DagNode, DagPoint } from "./dagLayout.js";

// The layered layout DagGraph draws a caller-ordered graph with (every node carrying `order`), in the classic steps:
// 1. ranks: each column a dependency depth; with `wrapAt`, a rank too wide for it split into lines, each a rank.
// 2. lanes: an edge that skips ranks gets a placeholder in every rank it passes, so the cards there make room for it
//    and its line never runs across one. Edges leaving one card share their placeholders: a trunk.
// 3. order: the caller's order, then sweeps that sort each rank by where its neighbours sit, kept only where they
//    cross fewer lines.
// 4. place: each card as near the cards it joins as the ones beside it allow, placeholders most of all, so a long line
//    runs straight.
// 5. route: each edge changes lane only in the middle of a gutter, from placeholder to placeholder.
// Worked in flow coordinates: `along` runs with the flow (x left to right, y top to bottom), `across` is the other one.

export interface LayeredPlacement {
    readonly nodes: ReadonlyMap<string, DagPoint>;
    readonly lanes: ReadonlyMap<string, readonly DagPoint[]>;
    readonly extent: DagExtent;
}

export interface DagExtent {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

type Spacing = DagLayoutOptions & { readonly rankSep: number; readonly nodeSep: number };

// Room between two lines passing side by side, and the least beside a card: two strokes read as two, a bundle as one.
const LANE_GAP = 6;
// How much more a placeholder holds to where its line wants it than a card does: long lines straight first.
const LANE_WEIGHT = 4;
const ORDER_SWEEPS = 8;
const PLACE_SWEEPS = 6;

// One way to split a rank: how many cards each line takes, and how wide the longest line comes out.
interface Wrap {
    readonly longest: number;
    readonly sizes: readonly number[];
}

// A stage wider than the frame wraps rather than shrinking the picture: onto as few lines as fit, split where its
// longest line comes out shortest (seven like cards are four and three, never six and one), in its own order. Each
// item's line, 0 first; every item on line 0 when they fit.
export const wrapLines = (widths: readonly number[], maxSpan: number, gap: number): number[] => {
    const count = widths.length;
    const span = (from: number, to: number): number => widths.slice(from, to).reduce((sum, width) => sum + width, 0) + Math.max(0, to - from - 1) * gap;
    const known = new Map<string, Wrap>();
    const split = (from: number, lines: number): Wrap => {
        if (lines === 1) {
            return { longest: span(from, count), sizes: [count - from] };
        }
        const remembered = known.get(`${from}/${lines}`);
        if (remembered !== undefined) {
            return remembered;
        }
        let best: Wrap = { longest: Number.POSITIVE_INFINITY, sizes: [] };
        // The fullest first line is tried first, so of two splits as good, the shorter line is the later one.
        for (let size = count - from - (lines - 1); size >= 1; size -= 1) {
            const rest = split(from + size, lines - 1);
            const longest = Math.max(span(from, from + size), rest.longest);
            if (longest < best.longest) {
                best = { longest, sizes: [size, ...rest.sizes] };
            }
        }
        known.set(`${from}/${lines}`, best);
        return best;
    };
    for (let lines = 1; lines <= count; lines += 1) {
        const { longest, sizes } = split(0, lines);
        if (longest <= maxSpan || lines === count) {
            return sizes.flatMap((size, line) => Array.from({ length: size }, () => line));
        }
    }
    return [];
};

// The graph as the steps below share it: sizes, and which ranks, lanes and segments there are.
interface Layers {
    readonly horizontal: boolean;
    readonly spanOf: (id: string) => number;
    readonly thicknessOf: (id: string) => number;
    // Every rank's cards and placeholders, in no order yet.
    readonly ranks: readonly (readonly string[])[];
    readonly rankFor: (id: string) => number;
    readonly lanes: ReadonlySet<string>;
    // Each edge's slots from source to target, by `from>to`.
    readonly chains: ReadonlyMap<string, readonly string[]>;
    readonly segments: readonly Segment[];
    // A slot's neighbours in the rank before and the rank after, weighted by how many edges the segment carries.
    readonly up: ReadonlyMap<string, readonly Neighbour[]>;
    readonly down: ReadonlyMap<string, readonly Neighbour[]>;
}

interface Segment {
    readonly from: string;
    readonly to: string;
    readonly weight: number;
}

interface Neighbour {
    readonly id: string;
    readonly weight: number;
}

const uniqueEdges = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[]): DagEdge[] => {
    const ids = new Set(nodes.map((node) => node.id));
    const seen = new Set<string>();
    return edges.filter((edge) => {
        const key = `${edge.from}>${edge.to}`;
        const fresh = ids.has(edge.from) && ids.has(edge.to) && !seen.has(key);
        seen.add(key);
        return fresh;
    });
};

// Depth, then lines. A wrapped rank puts the cards nothing waits on first, so the ones the next rank waits on sit on
// its last line, right above it, and no line has to pass through the rank to leave it.
const rankLines = (nodes: readonly DagNode<never>[], columns: ReadonlyMap<string, number>, leadsOn: ReadonlySet<string>, spanOf: (id: string) => number, options: Spacing): string[][] => {
    const byDepth = new Map<number, DagNode<never>[]>();
    for (const node of nodes) {
        byDepth.set(columns.get(node.id) ?? 0, [...(byDepth.get(columns.get(node.id) ?? 0) ?? []), node]);
    }
    return [...byDepth.keys()]
        .toSorted((one, other) => one - other)
        .flatMap((depth) => {
            const members = (byDepth.get(depth) ?? []).toSorted((one, other) => (one.order ?? 0) - (other.order ?? 0)).map((node) => node.id);
            const span = members.reduce((sum, id) => sum + spanOf(id), 0) + Math.max(0, members.length - 1) * options.nodeSep;
            if (options.wrapAt === undefined || span <= options.wrapAt) {
                return [members];
            }
            const sorted = [...members.filter((id) => !leadsOn.has(id)), ...members.filter((id) => leadsOn.has(id))];
            const lineOf = wrapLines(sorted.map(spanOf), options.wrapAt, options.nodeSep);
            return Array.from({ length: Math.max(...lineOf) + 1 }, (_, line) => sorted.filter((_id, index) => lineOf[index] === line));
        });
};

// Threads every edge through the ranks it skips: one placeholder per source and rank, so a card's long edges run as
// one trunk until each turns off it. Each step of a chain between neighbouring ranks is a segment; a backward or
// same-rank edge has none.
const threadLanes = (drawn: readonly DagEdge[], ranks: readonly (readonly string[])[]): Pick<Layers, `ranks` | `rankFor` | `lanes` | `chains` | `segments`> => {
    const rankOf = new Map(ranks.flatMap((members, rank) => members.map((id) => [id, rank] as const)));
    const withLanes = ranks.map((members) => [...members]);
    const chains = new Map<string, string[]>();
    for (const edge of drawn) {
        const chain = [edge.from];
        for (let rank = (rankOf.get(edge.from) ?? 0) + 1; rank < (rankOf.get(edge.to) ?? 0); rank += 1) {
            const id = `\u0000${edge.from}@${rank}`;
            if (!rankOf.has(id)) {
                rankOf.set(id, rank);
                withLanes[rank]?.push(id);
            }
            chain.push(id);
        }
        chains.set(`${edge.from}>${edge.to}`, [...chain, edge.to]);
    }
    const rankFor = (id: string): number => rankOf.get(id) ?? 0;
    const weights = new Map<string, Segment>();
    for (const chain of chains.values()) {
        chain.slice(1).forEach((to, index) => {
            const from = chain[index] ?? to;
            if (rankFor(to) === rankFor(from) + 1) {
                weights.set(`${from}>${to}`, { from, to, weight: (weights.get(`${from}>${to}`)?.weight ?? 0) + 1 });
            }
        });
    }
    const lanes = new Set([...rankOf.keys()].filter((id) => id.startsWith(`\u0000`)));
    return { ranks: withLanes, rankFor, lanes, chains, segments: [...weights.values()] };
};

const neighbours = (segments: readonly Segment[], side: `from` | `to`): Map<string, Neighbour[]> => {
    const out = new Map<string, Neighbour[]>();
    for (const segment of segments) {
        const at = side === `to` ? segment.to : segment.from;
        out.set(at, [...(out.get(at) ?? []), { id: side === `to` ? segment.from : segment.to, weight: segment.weight }]);
    }
    return out;
};

const mean = (list: readonly Neighbour[] | undefined, at: ReadonlyMap<string, number>): number | undefined => {
    const known = (list ?? []).filter((neighbour) => at.has(neighbour.id));
    const weight = known.reduce((sum, neighbour) => sum + neighbour.weight, 0);
    return weight === 0 ? undefined : known.reduce((sum, neighbour) => sum + (at.get(neighbour.id) ?? 0) * neighbour.weight, 0) / weight;
};

// A slot's place in its rank as a fraction, so ranks of different lengths compare.
const fractions = (order: readonly (readonly string[])[]): Map<string, number> =>
    new Map(order.flatMap((members) => members.map((id, index) => [id, members.length > 1 ? index / (members.length - 1) : 0.5] as const)));

// The caller's order for its cards; a placeholder goes in where its line enters the rank.
const seedOrder = (layers: Layers): string[][] => {
    const order = layers.ranks.map((members) => members.filter((id) => !layers.lanes.has(id)));
    for (let rank = 1; rank < order.length; rank += 1) {
        const at = fractions(order);
        const cards = order[rank] ?? [];
        const entering = (layers.ranks[rank] ?? []).filter((id) => layers.lanes.has(id));
        order[rank] = [
            ...cards.map((id, index) => ({ id, key: index })),
            ...entering.map((id) => ({ id, key: (mean(layers.up.get(id), at) ?? 0.5) * Math.max(0, cards.length - 1) + 0.25 })),
        ]
            .toSorted((one, other) => one.key - other.key)
            .map((entry) => entry.id);
    }
    return order;
};

// How many pairs of segments cross, each weighted by the edges it carries.
const crossings = (order: readonly (readonly string[])[], layers: Layers): number => {
    const at = new Map(order.flatMap((members) => members.map((id, index) => [id, index] as const)));
    const byRank = new Map<number, { a: number; b: number; weight: number }[]>();
    for (const segment of layers.segments) {
        const rank = layers.rankFor(segment.from);
        byRank.set(rank, [...(byRank.get(rank) ?? []), { a: at.get(segment.from) ?? 0, b: at.get(segment.to) ?? 0, weight: segment.weight }]);
    }
    let total = 0;
    for (const list of byRank.values()) {
        list.forEach((one, index) => {
            total += list.slice(index + 1).reduce((sum, other) => sum + ((one.a - other.a) * (one.b - other.b) < 0 ? one.weight * other.weight : 0), 0);
        });
    }
    return total;
};

// Sorts each rank by the mean place of its neighbours, down then up, and keeps whichever order crossed fewest lines,
// the seed's own on a tie.
const sweepOrder = (seed: readonly (readonly string[])[], layers: Layers): string[][] => {
    const order = seed.map((members) => [...members]);
    let best = seed.map((members) => [...members]);
    let fewest = crossings(best, layers);
    for (let sweep = 0; sweep < ORDER_SWEEPS && fewest > 0; sweep += 1) {
        const downward = sweep % 2 === 0;
        const sequence = order.map((_, rank) => rank);
        for (const rank of downward ? sequence.slice(1) : sequence.slice(0, -1).toReversed()) {
            const at = fractions(order);
            const members = order[rank] ?? [];
            order[rank] = members
                .map((id, index) => ({ id, index, key: mean((downward ? layers.up : layers.down).get(id), at) ?? at.get(id) ?? 0 }))
                .toSorted((one, other) => one.key - other.key || one.index - other.index)
                .map((entry) => entry.id);
        }
        const count = crossings(order, layers);
        if (count < fewest) {
            fewest = count;
            best = order.map((members) => [...members]);
        }
    }
    return best;
};

// The least-squares fit of each slot to where it wants to be, under the rule that neighbours keep their gaps:
// pool-adjacent-violators on the positions less the gaps before them, which is exact.
const fitInOrder = (wanted: readonly number[], weights: readonly number[], gaps: readonly number[]): number[] => {
    const offsets = gaps.reduce<number[]>((all, gap, index) => [...all, (all[index] ?? 0) + gap], [0]);
    const blocks: { value: number; weight: number; size: number }[] = [];
    wanted.forEach((want, index) => {
        blocks.push({ value: want - (offsets[index] ?? 0), weight: weights[index] ?? 1, size: 1 });
        for (let last = blocks.at(-1), before = blocks.at(-2); last !== undefined && before !== undefined && before.value > last.value; last = blocks.at(-1), before = blocks.at(-2)) {
            const weight = before.weight + last.weight;
            blocks.splice(-2, 2, { value: (before.value * before.weight + last.value * last.weight) / weight, weight, size: before.size + last.size });
        }
    });
    return blocks.flatMap((block) => Array.from({ length: block.size }, () => block.value)).map((value, index) => value + (offsets[index] ?? 0));
};

// Back inside [0, room] after a fit, neighbours still their gaps apart: pushed in from the right edge, then the left.
const clampInto = (centres: number[], spans: readonly number[], gaps: readonly number[], room: number): number[] => {
    const out = [...centres];
    for (let index = out.length - 1; index >= 0; index -= 1) {
        const limit = index === out.length - 1 ? room - (spans[index] ?? 0) / 2 : (out[index + 1] ?? 0) - (gaps[index] ?? 0);
        out[index] = Math.min(out[index] ?? 0, limit);
    }
    out.forEach((value, index) => {
        out[index] = Math.max(value, index === 0 ? (spans[0] ?? 0) / 2 : (out[index - 1] ?? 0) + (gaps[index - 1] ?? 0));
    });
    return out;
};

// Centres across the flow. Two cards keep the caller's gap; a line beside a card keeps half of it; two lines LANE_GAP.
// The picture is never wider across than its widest rank (or `wrapAt`, where a row may wrap to it): pulling cards
// toward what they join must not stagger the ranks out past the frame the wrapping was for.
const placeAcross = (order: readonly (readonly string[])[], layers: Layers, nodeSep: number, wrapAt: number | undefined): Map<string, number> => {
    const spanOf = (id: string): number => (layers.lanes.has(id) ? 0 : layers.spanOf(id));
    const gap = (one: string, other: string): number => {
        const lanes = Number(layers.lanes.has(one)) + Number(layers.lanes.has(other));
        return (spanOf(one) + spanOf(other)) / 2 + (lanes === 2 ? LANE_GAP : lanes === 1 ? Math.max(LANE_GAP, nodeSep / 2) : nodeSep);
    };
    const gapsOf = (members: readonly string[]): number[] => members.slice(1).map((id, index) => gap(members[index] ?? id, id));
    const centre = new Map<string, number>();
    const lengthOf = (members: readonly string[]): number => gapsOf(members).reduce((sum, value) => sum + value, 0) + spanOf(members[0] ?? ``) / 2 + spanOf(members.at(-1) ?? ``) / 2;
    const widest = Math.max(...order.map((members) => gapsOf(members).reduce((sum, value) => sum + value, 0)), 0);
    const room = Math.max(wrapAt ?? 0, ...order.map(lengthOf));
    for (const members of order) {
        const gaps = gapsOf(members);
        let at = (widest - gaps.reduce((sum, value) => sum + value, 0)) / 2 + (room - widest) / 2;
        members.forEach((id, index) => {
            at += index === 0 ? 0 : (gaps[index - 1] ?? 0);
            centre.set(id, at);
        });
    }
    const settle = (members: readonly string[], toward: (id: string) => readonly Neighbour[]): void => {
        const wants = members.map((id) => mean(toward(id), centre));
        const weights = wants.map((want, index) => (want === undefined ? 0.01 : layers.lanes.has(members[index] ?? ``) ? LANE_WEIGHT : 1));
        const gaps = gapsOf(members);
        const fitted = fitInOrder(
            wants.map((want, index) => want ?? centre.get(members[index] ?? ``) ?? 0),
            weights,
            gaps,
        );
        clampInto(fitted, members.map(spanOf), gaps, room).forEach((value, index) => centre.set(members[index] ?? ``, value));
    };
    const ranks = order.map((_, rank) => rank);
    for (let sweep = 0; sweep < PLACE_SWEEPS; sweep += 1) {
        const downward = sweep % 2 === 0;
        for (const rank of downward ? ranks.slice(1) : ranks.slice(0, -1).toReversed()) {
            settle(order[rank] ?? [], (id) => (downward ? layers.up : layers.down).get(id) ?? []);
        }
    }
    // Last, both sides at once, so a card between two ranks sits between what it joins.
    for (const members of order) {
        settle(members, (id) => [...(layers.up.get(id) ?? []), ...(layers.down.get(id) ?? [])]);
    }
    const low = Math.min(...[...centre.entries()].map(([id, at]) => at - spanOf(id) / 2), 0);
    return new Map([...centre.entries()].map(([id, at]) => [id, at - low]));
};

const buildLayers = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[], columns: ReadonlyMap<string, number>, options: Spacing): Layers => {
    const horizontal = options.direction === `LR`;
    const box = new Map(nodes.map((node) => [node.id, { width: node.width ?? options.nodeWidth, height: node.height ?? options.nodeHeight }]));
    const spanOf = (id: string): number => (horizontal ? box.get(id)?.height : box.get(id)?.width) ?? 0;
    const thicknessOf = (id: string): number => (horizontal ? box.get(id)?.width : box.get(id)?.height) ?? 0;
    const drawn = uniqueEdges(nodes, edges);
    const threaded = threadLanes(drawn, rankLines(nodes, columns, new Set(drawn.map((edge) => edge.from)), spanOf, options));
    return { ...threaded, horizontal, spanOf, thicknessOf, up: neighbours(threaded.segments, `to`), down: neighbours(threaded.segments, `from`) };
};

export const layered = (nodes: readonly DagNode<never>[], edges: readonly DagEdge[], columns: ReadonlyMap<string, number>, options: Spacing): LayeredPlacement => {
    const layers = buildLayers(nodes, edges, columns, options);
    const order = sweepOrder(seedOrder(layers), layers);
    const centre = placeAcross(order, layers, options.nodeSep, options.wrapAt);

    // Along: each rank as thick as its thickest card, a gutter apart. Left to right a card is centred in its column; top
    // to bottom a row's cards share its top edge, so a tall card hangs down rather than floating mid-row.
    const thickness = order.map((members) => Math.max(...members.map((id) => (layers.lanes.has(id) ? 0 : layers.thicknessOf(id))), 0));
    const starts = thickness.map((_, rank) => thickness.slice(0, rank).reduce((sum, value) => sum + value + options.rankSep, 0));
    const point = (along: number, across: number): DagPoint => (layers.horizontal ? { x: along, y: across } : { x: across, y: along });
    const placed = new Map<string, DagPoint>();
    order.forEach((members, rank) => {
        for (const id of members.filter((member) => !layers.lanes.has(member))) {
            const inset = layers.horizontal ? ((thickness[rank] ?? 0) - layers.thicknessOf(id)) / 2 : 0;
            placed.set(id, point((starts[rank] ?? 0) + inset, (centre.get(id) ?? 0) - layers.spanOf(id) / 2));
        }
    });

    // Route: slot to slot, changing lane in the middle of each gutter; the last change is to the target's own lane.
    const gutterAfter = (rank: number): number => (starts[rank] ?? 0) + (thickness[rank] ?? 0) + options.rankSep / 2;
    const routes = new Map<string, readonly DagPoint[]>();
    for (const [key, chain] of layers.chains) {
        const from = layers.rankFor(chain[0] ?? ``);
        const passes = chain.slice(0, -1);
        const forward = layers.rankFor(chain.at(-1) ?? ``) > from;
        routes.set(key, forward ? passes.map((id, index) => point(gutterAfter(from + index), centre.get(passes[index + 1] ?? id) ?? 0)) : []);
    }

    const across = Math.max(...[...centre.entries()].map(([id, at]) => at + (layers.lanes.has(id) ? 1 : layers.spanOf(id) / 2)), 0);
    const along = (starts.at(-1) ?? 0) + (thickness.at(-1) ?? 0);
    return { nodes: placed, lanes: routes, extent: layers.horizontal ? { x: 0, y: 0, width: along, height: across } : { x: 0, y: 0, width: across, height: along } };
};
