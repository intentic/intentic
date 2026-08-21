/* WHERE AN ANCHORED BOX GOES, measured against the window the ANCHOR is in, never against a module-scope one.
 *
 * Pure geometry, no DOM: the caller reads the anchor's rect and its window's size and applies what comes back.
 * That signature is the whole point. A library that positions with the module-scope `window.innerHeight`
 * (PrimeVue's overlays do, and so did PrimeVue's tooltip before this app grew its own) decides "does it fit
 * above the trigger?" against a viewport the box may not land in, and gets it wrong in the way that costs most:
 * a picker placed off the bottom edge, its top over the very pill that opens it, and an overlay covering its own
 * trigger cannot be closed by clicking that trigger. The app's floating panels used to make that certain, since
 * they were rendered into another window entirely; they are their own windows now, but the app still draws into
 * iframes (the preview, the extension host), so deriving the viewport from the ANCHOR remains the only reading
 * that cannot be wrong.
 *
 * So the view is an argument. Every reader of it (AnchoredOverlay, the tooltip directive) passes the one it
 * measured from `el.ownerDocument.defaultView`, and being right in either window stops being a thing anyone
 * has to remember. */

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
    // The box AS IT CURRENTLY MEASURES. Deliberately not a "natural" size: re-measuring an uncapped box on
    // every reposition is what makes a ResizeObserver-driven overlay oscillate between two heights forever.
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
    // The room the chosen side has, for the box's max-height (vertical sides), the cap that keeps a tall panel
    // inside the window instead of hanging off it, unreachable.
    readonly maxHeight: number;
    // The anchor's centre in the box's own coordinates: an arrow drawn there points at the anchor even when the
    // box has been shoved sideways to stay on screen.
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
    /* FLIP ONLY WHEN IT HELPS. The preferred side keeps the box unless it doesn't fit there AND the opposite
     * side has more room, flipping into an equally cramped side moves the clipping without fixing it, and
     * flipping a box that already fits is the jitter every "why did my menu jump?" report is made of. The box
     * measures as it currently is (see PlacementInput.box), so a box already capped to the preferred side's
     * room fits by construction and this is stable across repositions. */
    const chosen = span(side) <= room[side] || room[OPPOSITE[side]] <= room[side] ? side : OPPOSITE[side];
    const vertical = chosen === `top` || chosen === `bottom`;
    // A box taller than its side's room is capped to it; one that fits keeps its own height, and the cap is
    // still reported so the caller can pin it (a panel that GROWS later must stay inside the window).
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
