/* THE WAY FROM A TRIGGER TO THE PANEL IT RAISED, for a panel the pointer opens without a press. A pointer heading for
   the panel leaves the trigger, crosses whatever lies between, and only then arrives; a straight line to a lower row
   cuts across the rail tiles beneath the trigger. The corridor is the triangle from where it left to the panel's facing
   edge: while the pointer is inside it, it is still on its way, and the panel waits for it. Outside it, it went
   somewhere else, and the panel's ordinary grace is all it gets. */

export interface Point {
    readonly x: number;
    readonly y: number;
}

// The panel, in the same client coordinates as the point (a DOMRect satisfies this).
export interface CorridorRect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

// How far behind the exit the corridor's apex sits, in px: a corridor that started exactly at the exit would be a
// point wide there, and the first wobble of a hand would fall out of it.
const SLACK = 6;

// The panel's edge that faces a point outside it, with the way back from it (the apex's slack goes that way); undefined
// for a point already over it.
const facingEdge = (from: Point, rect: CorridorRect): { readonly edge: readonly [Point, Point]; readonly back: Point } | undefined => {
    if (from.x <= rect.left) {
        return { edge: [{ x: rect.left, y: rect.top }, { x: rect.left, y: rect.bottom }], back: { x: -1, y: 0 } };
    }
    if (from.x >= rect.right) {
        return { edge: [{ x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }], back: { x: 1, y: 0 } };
    }
    if (from.y <= rect.top) {
        return { edge: [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }], back: { x: 0, y: -1 } };
    }
    if (from.y >= rect.bottom) {
        return { edge: [{ x: rect.left, y: rect.bottom }, { x: rect.right, y: rect.bottom }], back: { x: 0, y: 1 } };
    }
    return undefined;
};

// Which side of the line a→b the point p falls on, as a signed area.
const side = (a: Point, b: Point, p: Point): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

// Inside or on the edge of triangle abc, whichever way it winds.
const inTriangle = (p: Point, a: Point, b: Point, c: Point): boolean => {
    const ab = side(a, b, p);
    const bc = side(b, c, p);
    const ca = side(c, a, p);
    const negative = ab < 0 || bc < 0 || ca < 0;
    const positive = ab > 0 || bc > 0 || ca > 0;
    return !(negative && positive);
};

/** Whether a pointer at `point`, having left its trigger at `exit`, is still heading for `rect`. */
export const inCorridor = (point: Point, exit: Point, rect: CorridorRect): boolean => {
    const facing = facingEdge(exit, rect);
    if (facing === undefined) {
        return true;
    }
    const { edge, back } = facing;
    const apex = { x: exit.x + back.x * SLACK, y: exit.y + back.y * SLACK };
    return inTriangle(point, apex, edge[0], edge[1]);
};
