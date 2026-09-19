import { type DeskLayout, rowIndexOf } from "./deskLayout";

// Arrow-key travel over the desk's tiles, done on the layout's own rows rather than their painted rectangles: the desk
// windows itself, so an off-screen tile has no rectangle to measure, and measuring the on-screen ones cost a forced
// reflow per keystroke. Pure, no DOM.

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

const GRID_KEYS: ReadonlySet<string> = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);
export const isGridKey = (key: string): key is GridKey => GRID_KEYS.has(key);

// The tile one row away in `direction`, holding its column; a shorter row lands on its last tile, which is the one
// nearest under the pointer. The current index where no such row exists, so a key at the edge holds rather than
// wrapping to somewhere unrelated.
const acrossRows = (layout: DeskLayout, index: number, direction: 1 | -1): number => {
    const at = rowIndexOf(layout, index);
    if (at === -1) {
        return index;
    }
    const next = layout.rows[at + direction];
    if (next === undefined) {
        return index;
    }
    const column = index - layout.rows[at]!.start;
    return next.start + Math.min(column, next.count - 1);
};

// Where a key lands from no selection (-1): the first tile, or the last for End.
const enterGrid = (key: GridKey, last: number): number => (key === `End` ? last : 0);

// Where a key lands. Left and right walk desk order, which crosses a group boundary the way the eye does; up and down
// go by the laid-out rows, which is the same thing the eye does down a column.
export const moveInGrid = (layout: DeskLayout, index: number, key: GridKey): number => {
    const last = layout.count - 1;
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
            return acrossRows(layout, index, -1);
        case `ArrowDown`:
            return acrossRows(layout, index, 1);
        default:
            return enterGrid(key, last);
    }
};
