// THE MAP'S LINES, AS ARITHMETIC. The stage lays its cards out with CSS and measures where they landed; this turns those
// rectangles into the curves between them. Pure, so the shape of a line is tested rather than eyeballed.

export interface Rect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

export interface Point {
    readonly x: number;
    readonly y: number;
}

/** `across`: principals, box and reach side by side, lines running left to right. `down`: stacked, lines running down. */
export type Flow = `across` | `down`;

/** Where a line leaves a card: its trailing edge's middle. */
export const exitOf = (rect: Rect, flow: Flow): Point =>
    flow === `across` ? { x: rect.right, y: (rect.top + rect.bottom) / 2 } : { x: (rect.left + rect.right) / 2, y: rect.bottom };

/** Where a line arrives at a card: its leading edge's middle. */
export const entryOf = (rect: Rect, flow: Flow): Point =>
    flow === `across` ? { x: rect.left, y: (rect.top + rect.bottom) / 2 } : { x: (rect.left + rect.right) / 2, y: rect.top };

/**
 * A curve leaving `from` and arriving at `to` along the flow, both ends level with it so a fan of them reads as one
 * bundle. The handles reach half the gap, never less than a short stub, so a near-level pair still bends rather than
 * kinking.
 */
export const curve = (from: Point, to: Point, flow: Flow): string => {
    const round = (value: number): number => Math.round(value * 10) / 10;
    if (flow === `across`) {
        const reach = Math.max(24, Math.abs(to.x - from.x) / 2);
        return `M${round(from.x)} ${round(from.y)} C${round(from.x + reach)} ${round(from.y)} ${round(to.x - reach)} ${round(to.y)} ${round(to.x)} ${round(to.y)}`;
    }
    const reach = Math.max(24, Math.abs(to.y - from.y) / 2);
    return `M${round(from.x)} ${round(from.y)} C${round(from.x)} ${round(from.y + reach)} ${round(to.x)} ${round(to.y - reach)} ${round(to.x)} ${round(to.y)}`;
};

/**
 * A line that leaves `from` level, turns once onto a shared spine at `spine`, runs along it, and turns again to arrive at
 * `to` level: every line bound for one side of the box merges onto one spine, so a long column of cards reads as a bus
 * with short branches rather than a rope of near-vertical curves. The corners are rounded, never wider than the room.
 */
export const elbow = (from: Point, to: Point, spine: number, radius = 10): string => {
    const round = (value: number): number => Math.round(value * 10) / 10;
    const rise = to.y - from.y;
    if (Math.abs(rise) < 0.5) {
        return `M${round(from.x)} ${round(from.y)} H${round(to.x)}`;
    }
    const r = Math.min(radius, Math.abs(rise) / 2, Math.abs(spine - from.x), Math.abs(to.x - spine));
    const down = Math.sign(rise);
    const out = Math.sign(spine - from.x);
    const onward = Math.sign(to.x - spine);
    return [
        `M${round(from.x)} ${round(from.y)}`,
        `H${round(spine - out * r)}`,
        `Q${round(spine)} ${round(from.y)} ${round(spine)} ${round(from.y + down * r)}`,
        `V${round(to.y - down * r)}`,
        `Q${round(spine)} ${round(to.y)} ${round(spine + onward * r)} ${round(to.y)}`,
        `H${round(to.x)}`,
    ].join(` `);
};

/**
 * Points along one edge of the box, one per cluster that meets it (a door per kind of principal, a port per group), each
 * as near its cluster's middle as the edge allows and never closer to the next than `gap`: a cluster beside the box gets
 * a straight line, one below it a short climb.
 */
export const portsAlong = (wanted: readonly number[], from: number, to: number, gap: number): number[] => {
    const inset = Math.min(gap, (to - from) / 2);
    const low = from + inset;
    const high = to - inset;
    const placed: number[] = [];
    for (const want of wanted) {
        const previous = placed.at(-1);
        const floor = previous === undefined ? low : previous + gap;
        placed.push(Math.max(floor, Math.min(high, want)));
    }
    // A run pushed past the far end slides back as one, keeping its spacing, and stops at the near end.
    for (let index = placed.length - 1; index >= 0; index -= 1) {
        const next = placed[index + 1];
        const ceiling = next === undefined ? high : next - gap;
        placed[index] = Math.max(low, Math.min(placed[index] ?? low, ceiling));
    }
    return placed;
};

/** A rectangle relative to the stage it was measured in. */
export const within = (rect: DOMRectReadOnly, stage: DOMRectReadOnly): Rect => ({
    left: rect.left - stage.left,
    top: rect.top - stage.top,
    right: rect.right - stage.left,
    bottom: rect.bottom - stage.top,
});
