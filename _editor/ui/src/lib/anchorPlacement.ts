/* WHERE AN ANCHORED BOX GOES, measured against the window the ANCHOR is in, never against a module-scope one. */

export type Side = "top" | "bottom" | "left" | "right";
// Where the box sits along the anchor's own axis: centred on it, or flush with its start/end edge.
export type Cross = "center" | "start" | "end";

export interface Size {
    readonly width: number;
    readonly height: number;
}

// The anchor, in its window's client coordinates (a DOMRect satisfies this).
export interface AnchorRect {
    readonly top: number;
    readonly left: number;
    readonly width: number;
    readonly height: number;
}

export interface PlacementInput {
    readonly anchor: AnchorRect;
    // The box's current measured size, not a natural size: re-measuring an uncapped box would oscillate forever.
    readonly box: Size;
    // The anchor's own window (innerWidth/innerHeight).
    readonly view: Size;
    readonly side: Side;
    readonly cross: Cross;
    // Space between anchor and box, an arrow's height.
    readonly gap: number;
    // Viewport margin kept clear on every edge.
    readonly edge: number;
}

export interface Placement {
    // The side the box actually ended up on, which the caller needs for the arrow's class.
    readonly side: Side;
    readonly left: number;
    readonly top: number;
    // Room on the chosen side, for the box's max-height; keeps a tall panel inside the window.
    readonly maxHeight: number;
    // Anchor's centre in box coordinates; an arrow drawn there still points at the anchor after a sideways shove.
    readonly arrow: number;
}

const OPPOSITE: Record<Side, Side> = { top: `bottom`, bottom: `top`, left: `right`, right: `left` };

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

export const placeAnchored = ({ anchor, box, view, side, cross, gap, edge }: PlacementInput): Placement => {
    const room: Record<Side, number> = {
        top: anchor.top - gap - edge,
        bottom: view.height - (anchor.top + anchor.height) - gap - edge,
        left: anchor.left - gap - edge,
        right: view.width - (anchor.left + anchor.width) - gap - edge,
    };
    const span = (place: Side): number => (place === `top` || place === `bottom` ? box.height : box.width);
    // Flips only if the preferred side doesn't fit and the opposite has strictly more room; otherwise stays put.
    const chosen = span(side) <= room[side] || room[OPPOSITE[side]] <= room[side] ? side : OPPOSITE[side];
    const vertical = chosen === `top` || chosen === `bottom`;
    // A box taller than its room is capped; the cap is still reported for callers whose box grows later.
    const height = Math.min(box.height, Math.max(room[chosen], 0));

    const left = vertical
        ? clamp(
              cross === `center`
                  ? anchor.left + anchor.width / 2 - box.width / 2
                  : cross === `start`
                    ? anchor.left
                    : anchor.left + anchor.width - box.width,
              edge,
              view.width - box.width - edge,
          )
        : chosen === `left`
          ? anchor.left - gap - box.width
          : anchor.left + anchor.width + gap;
    const top = vertical
        ? chosen === `top`
            ? anchor.top - gap - height
            : anchor.top + anchor.height + gap
        : clamp(
              cross === `center` ? anchor.top + anchor.height / 2 - height / 2 : cross === `start` ? anchor.top : anchor.top + anchor.height - height,
              edge,
              view.height - height - edge,
          );

    const centre = vertical ? anchor.left + anchor.width / 2 - left : anchor.top + anchor.height / 2 - top;
    return {
        side: chosen,
        left,
        top,
        maxHeight: vertical ? Math.max(room[chosen], 0) : Math.max(view.height - 2 * edge, 0),
        arrow: clamp(centre, 0, vertical ? box.width : height),
    };
};
