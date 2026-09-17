// Arrow-key travel over the desk's tiles, done on their painted rectangles rather than a column count: the grid is
// auto-fill and restarts at every group label, so no index arithmetic knows which tile sits under another. Pure, no
// DOM: the view hands in each tile's box in document order.

export interface TileBox {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

const GRID_KEYS: ReadonlySet<string> = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);
export const isGridKey = (key: string): key is GridKey => GRID_KEYS.has(key);

const centerX = (box: TileBox): number => box.left + box.width / 2;

// The tile in the nearest row in `direction` (below for +1, above for -1) whose centre is closest horizontally; the
// current index where no such row exists, so a key at the edge holds rather than wrapping to somewhere unrelated.
const nearestAcrossRows = (boxes: readonly TileBox[], index: number, direction: 1 | -1): number => {
    const from = boxes[index];
    if (from === undefined) {
        return index;
    }
    const x = centerX(from);
    let best = index;
    let bestRow = Number.POSITIVE_INFINITY;
    let bestDx = Number.POSITIVE_INFINITY;
    for (const [candidate, box] of boxes.entries()) {
        // Half a tile past this one's top: rows share a top, so anything nearer is the same row.
        const rowGap = (box.top - from.top) * direction;
        if (rowGap <= from.height / 2) {
            continue;
        }
        const dx = Math.abs(centerX(box) - x);
        if (rowGap < bestRow || (rowGap === bestRow && dx < bestDx)) {
            best = candidate;
            bestRow = rowGap;
            bestDx = dx;
        }
    }
    return best;
};

// Where a key lands from no selection (-1): the first tile, or the last for End.
const enterGrid = (key: GridKey, last: number): number => (key === `End` ? last : 0);

// Where a key lands. Left and right walk document order, which crosses a group boundary the way the eye does; up and
// down go by the painted rows.
export const moveInGrid = (boxes: readonly TileBox[], index: number, key: GridKey): number => {
    const last = boxes.length - 1;
    if (last < 0) {
        return -1;
    }
    if (index < 0 || index > last) {
        return enterGrid(key, last);
    }
    switch (key) {
        case `ArrowLeft`:
            return Math.max(0, index - 1);
        case `ArrowRight`:
            return Math.min(last, index + 1);
        case `ArrowUp`:
            return nearestAcrossRows(boxes, index, -1);
        case `ArrowDown`:
            return nearestAcrossRows(boxes, index, 1);
        default:
            return enterGrid(key, last);
    }
};
