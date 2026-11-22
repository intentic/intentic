import { curve, elbow, entryOf, exitOf, type Point, type Rect } from "../../../lib/geometry/mapGeometry";
import type { AccountGraph, EdgeKind, GraphEdge, GraphLighting } from "./accountGraph";

// THE ACCESS MAP'S LINES, FROM WHERE ITS CARDS LANDED. The stage lays the account, its sandboxes and what they reach out in
// three columns with CSS and measures them; this turns those rectangles into lines. The account's way into each sandbox
// runs along one spine in the first gap, so a long column reads as a bus with short branches. What a sandbox reaches
// crosses the second gap as a curve. A tie between two sandboxes loops out past their trailing edge and back, leaving a
// little above the middle and arriving a little below it, so it never shares a point with the curves beside it. Pure:
// the layout is measured elsewhere (sandbox/map/useMapLayout.ts does the same for the sandbox's own map).

export type LineState = `rest` | `on` | `off`;

export interface Line {
    readonly key: string;
    readonly d: string;
    readonly kind: EdgeKind;
    readonly state: LineState;
    /** Others' only: the reader's own conversations cannot use it. */
    readonly faint: boolean;
    /** Ends at an arrowhead: a tie between two sandboxes, which runs one way. */
    readonly arrow: boolean;
}

export interface AccessLayout {
    readonly width: number;
    readonly height: number;
    readonly nodes: ReadonlyMap<string, Rect>;
}

/** How far a tie between two sandboxes leaves the middle of a card's edge, so it sits apart from the curves there. */
const LINK_OFFSET = 7;
/** How far past the column a tie between two sandboxes loops at least, and how much more for each pixel it climbs. */
const LOOP_MIN = 18;
const LOOP_PER_RISE = 0.18;
const LOOP_MAX = 64;

const round = (value: number): number => Math.round(value * 10) / 10;

/** A loop out past the trailing edges of two cards in one column and back, from `from` to `to`. */
const loopPath = (from: Point, to: Point): string => {
    const reach = Math.max(from.x, to.x) + Math.min(LOOP_MAX, LOOP_MIN + Math.abs(to.y - from.y) * LOOP_PER_RISE);
    return `M${round(from.x)} ${round(from.y)} C${round(reach)} ${round(from.y)} ${round(reach)} ${round(to.y)} ${round(to.x)} ${round(to.y)}`;
};

const stateOf = (lighting: GraphLighting | undefined, edge: GraphEdge): LineState => (lighting === undefined ? `rest` : lighting.edges.has(edge.id) ? `on` : `off`);

const pathOf = (edge: GraphEdge, from: Rect, to: Rect, spine: number): string => {
    if (edge.kind === `member`) {
        return elbow(exitOf(from, `across`), entryOf(to, `across`), spine);
    }
    if (edge.kind === `link`) {
        const leave = exitOf(from, `across`);
        const arrive = exitOf(to, `across`);
        return loopPath({ x: leave.x, y: leave.y - LINK_OFFSET }, { x: arrive.x, y: arrive.y + LINK_OFFSET });
    }
    return curve(exitOf(from, `across`), entryOf(to, `across`), `across`);
};

/** Every line between two cards that were both drawn; a tie to something not on the stage draws nothing. */
export const drawLines = (layout: AccessLayout, graph: AccountGraph, lighting: GraphLighting | undefined): Line[] => {
    const you = layout.nodes.get(graph.you.id);
    // The first gap's middle, where the account's branches meet: halfway from its card to the column of sandboxes.
    const firstColumn = graph.sandboxes.map((sandbox) => layout.nodes.get(sandbox.id)?.left).find((left) => left !== undefined);
    const spine = you === undefined || firstColumn === undefined ? 0 : (you.right + firstColumn) / 2;
    return graph.edges.flatMap((edge) => {
        const from = layout.nodes.get(edge.from);
        const to = layout.nodes.get(edge.to);
        if (from === undefined || to === undefined) {
            return [];
        }
        return [
            {
                key: edge.id,
                d: pathOf(edge, from, to, spine),
                kind: edge.kind,
                state: stateOf(lighting, edge),
                faint: edge.kind !== `member` && edge.kind !== `runs` && !edge.yours,
                arrow: edge.kind === `link`,
            },
        ];
    });
};
