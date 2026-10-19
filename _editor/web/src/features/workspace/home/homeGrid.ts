import { type HomeLayout, type HomeRow, rowIndexOf } from "./homeLayout";

// Arrow-key travel over the home's tiles, done on the layout's own rows rather than their painted rectangles: the home
// windows itself, so an off-screen tile has no rectangle to measure, and measuring the on-screen ones cost a forced
// reflow per keystroke. Pure, no DOM.

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

const GRID_KEYS: ReadonlySet<string> = new Set([`ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`]);
export const isGridKey = (key: string): key is GridKey => GRID_KEYS.has(key);

// Where across the pane a tile stands, its edges from 0 to 1: a gallery row says; a grid row's columns are even.
const spanIn = (row: HomeRow, columns: number, column: number): readonly [number, number] =>
    row.spans?.[column] ?? [column / Math.max(1, columns), (column + 1) / Math.max(1, columns)];

// The tile one row away in `direction`, holding its column; a shorter row lands on its last tile, which is the one
// nearest under the pointer. Into or out of a gallery row, where pictures are as wide as they are, it lands on the one
// standing under the middle of the tile left, or the nearest to it where the row stops short. The current index where no such row exists, so a key at the edge holds rather
// than wrapping to somewhere unrelated.
const acrossRows = (layout: HomeLayout, index: number, direction: 1 | -1): number => {
    const at = rowIndexOf(layout, index);
    if (at === -1) {
        return index;
    }
    const row = layout.rows[at]!;
    const next = layout.rows[at + direction];
    if (next === undefined) {
        return index;
    }
    const column = index - row.start;
    if (row.spans === undefined && next.spans === undefined) {
        return next.start + Math.min(column, next.count - 1);
    }
    const [left, right] = spanIn(row, layout.columns, column);
    const middle = (left + right) / 2;
    // How far a tile's edges are from the middle: zero for the one standing under it.
    const distance = (candidate: number): number => {
        const [from, to] = spanIn(next, layout.columns, candidate);
        return middle < from ? from - middle : middle > to ? middle - to : 0;
    };
    let nearest = 0;
    for (let candidate = 1; candidate < next.count; candidate += 1) {
        if (distance(candidate) < distance(nearest)) {
            nearest = candidate;
        }
    }
    return next.start + nearest;
};

// Where a key lands from no selection (-1): the first tile, or the last for End.
const enterGrid = (key: GridKey, last: number): number => (key === `End` ? last : 0);

// Where a key lands. Left and right walk home order, which crosses a group boundary the way the eye does; up and down
// go by the laid-out rows, which is the same thing the eye does down a column.
export const moveInGrid = (layout: HomeLayout, index: number, key: GridKey): number => {
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
