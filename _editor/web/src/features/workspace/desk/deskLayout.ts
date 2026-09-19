import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { DeskGroup } from "./deskOrder";

// The desk's tiles as a list of fixed-height bands: a group label, or one row of tiles. Turning the grid into a list is
// what lets the desk window itself — a folder of fifty thousand files then paints the dozen rows on screen and no more.
// Pure, no DOM: the view measures the column count and the band heights off a probe and hands them in, so the CSS stays
// the single source of truth for both.

export type DeskBand =
    | { readonly kind: "label"; readonly key: string; readonly label: string }
    | {
          readonly kind: "tiles";
          readonly key: string;
          readonly entries: readonly WorkspaceTreeEntry[];
          // Where this band's first tile sits on the keyboard axis (deskOrder), so a band knows its own indices.
          readonly start: number;
      };

// A tile band as keyboard travel sees it: which band, and which stretch of desk order it covers.
export interface DeskRow {
    readonly band: number;
    readonly start: number;
    readonly count: number;
}

export interface DeskLayout {
    readonly bands: readonly DeskBand[];
    // Band heights in the same order, for the window's metrics.
    readonly heights: readonly number[];
    // Tile bands only: the rows Up and Down move between. Label bands are not travelled to.
    readonly rows: readonly DeskRow[];
    readonly columns: number;
    // Tiles in total, which is `deskOrder(groups).length`.
    readonly count: number;
}

export interface DeskMetrics {
    // Tracks the grid resolves to at this width; at least one, so a narrow pane still lays out.
    readonly columns: number;
    // A tile row's full height, gap included: bands are placed by offset, so the gap has to live in the height.
    readonly tileHeight: number;
    readonly labelHeight: number;
}

export const EMPTY_LAYOUT: DeskLayout = { bands: [], heights: [], rows: [], columns: 1, count: 0 };

/**
 * Lay a folder's groups out as bands.
 *
 * @param groups The folder's entries, already grouped and sorted (`deskGroups`).
 * @param showLabels Whether group labels earn a band (`labelsShown`): a folder of one kind reads without them.
 */
export const deskLayout = (groups: readonly DeskGroup[], showLabels: boolean, metrics: DeskMetrics): DeskLayout => {
    const columns = Math.max(1, Math.floor(metrics.columns));
    const bands: DeskBand[] = [];
    const heights: number[] = [];
    const rows: DeskRow[] = [];
    let start = 0;
    for (const group of groups) {
        if (showLabels) {
            bands.push({ kind: `label`, key: `${group.key}#label`, label: group.label });
            heights.push(metrics.labelHeight);
        }
        for (let at = 0; at < group.entries.length; at += columns) {
            const entries = group.entries.slice(at, at + columns);
            rows.push({ band: bands.length, start: start + at, count: entries.length });
            // Keyed on the group and the row's first index, not on an entry: a rename must not re-key the whole band.
            bands.push({ kind: `tiles`, key: `${group.key}#${at}`, entries, start: start + at });
            heights.push(metrics.tileHeight);
        }
        start += group.entries.length;
    }
    return { bands, heights, rows, columns, count: start };
};

// Position in `rows` of the tile row holding a desk-order index, by binary search; -1 when the index is out of range.
// The position, not the row: travel steps to `rows[at - 1]` and `rows[at + 1]`, which a row alone could not name.
export const rowIndexOf = (layout: DeskLayout, index: number): number => {
    if (index < 0 || index >= layout.count) {
        return -1;
    }
    let low = 0;
    let high = layout.rows.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (layout.rows[mid]!.start <= index) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
};

// Which band to render a given desk-order index in, for scrolling a tile into view.
export const bandOfIndex = (layout: DeskLayout, index: number): number => {
    const at = rowIndexOf(layout, index);
    return at === -1 ? 0 : layout.rows[at]!.band;
};
