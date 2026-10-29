/* WHERE THE LANE STANDS ON A DESKTOP. The bottom-right corner is the busiest in the app: the side chat's composer and
   send button, the status bar's meters, a settings card's own controls. The bottom-left, beside the icon rail and over
   the status bar, is the quietest in every view: the tail of a file tree, a settings nav's empty foot, a board's open
   ground. So the lane takes that corner, at one gap from the rail and from what it stands on.

   Both edges are measured rather than declared, because both move: the rail narrows (compact) or is absent (a page
   outside the shell, a popped-out window), and the status bar grows when its metrics panel opens. A few controls do
   live at the bottom-left of a view (the chat roster's New agent, a composer on a narrow window, the quick-ask pill),
   and each marks itself a floor: the lane stands on the highest floor under its own column, never over it. */

/** The rail every shell draws (ShellDesktop, MasterRail, LocalShell): the lane stands just right of it. */
export const LANE_WALL = `.icon-rail`;

/** Anything the lane must not cover at the foot of the window: the status bar, and the controls that sit there. */
export const LANE_FLOOR = `[data-lane-floor]`;

/** One gap from the rail and from the floor: the card's own padding, so the card reads as set into the corner. */
export const LANE_GAP_PX = 12;

export interface LaneBox {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}

export interface LaneSeat {
    /** From the viewport's left edge to the lane's. */
    readonly left: number;
    /** From the viewport's bottom edge to the lane's. */
    readonly bottom: number;
}

const drawn = (box: LaneBox): boolean => box.right > box.left && box.bottom > box.top;

/**
 * The lane's corner. A wall counts when it stands in the left half (the rail, not a right-hand column that happens to
 * match); a floor counts when it is in the lower half and under the lane's column, `width` wide from its left edge.
 */
export const laneSeat = (walls: readonly LaneBox[], floors: readonly LaneBox[], viewport: { readonly width: number; readonly height: number }, width: number): LaneSeat => {
    const wall = walls.filter((box) => drawn(box) && box.right <= viewport.width / 2).reduce((edge, box) => Math.max(edge, box.right), 0);
    const left = wall + LANE_GAP_PX;
    const floor = floors
        .filter((box) => drawn(box) && box.top >= viewport.height / 2 && box.left < left + width && box.right > left)
        .reduce((edge, box) => Math.min(edge, box.top), viewport.height);
    return { left, bottom: viewport.height - floor + LANE_GAP_PX };
};

/* A wall or floor arriving or leaving is the DOM change that can move the corner; anything else is a resize the
   observers already see. */
const holdsMark = (nodes: NodeList): boolean =>
    [...nodes].some(
        (node) => node instanceof Element && (node.matches(`${LANE_WALL}, ${LANE_FLOOR}`) || node.querySelector(`${LANE_WALL}, ${LANE_FLOOR}`) !== null),
    );

/** Whether a batch of DOM records put a wall or a floor into the document or took one out. */
export const marksChanged = (records: readonly MutationRecord[]): boolean =>
    records.some((record) => holdsMark(record.addedNodes) || holdsMark(record.removedNodes));
