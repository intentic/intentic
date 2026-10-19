import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { type GalleryMetrics, justifyRows } from "./homeGallery";
import type { HomeGroup } from "./homeOrder";

// The home's tiles as a list of fixed-height bands: a group label, or one row of tiles. Turning the grid into a list is
// what lets the home window itself — a folder of fifty thousand files then paints the dozen rows on screen and no more.
// Pure, no DOM: the view measures the column count and the band heights off a probe and hands them in, so the CSS stays
// the single source of truth for both. In a gallery a group of pictures is laid out as justified rows (homeGallery.ts)
// instead: still bands, each one row, only each its own height.

export type HomeBand =
    | { readonly kind: "label"; readonly key: string; readonly label: string }
    | {
          readonly kind: "tiles";
          readonly key: string;
          readonly entries: readonly WorkspaceTreeEntry[];
          // Where this band's first tile sits on the keyboard axis (homeOrder), so a band knows its own indices.
          readonly start: number;
      }
    | {
          readonly kind: "gallery";
          readonly key: string;
          readonly entries: readonly WorkspaceTreeEntry[];
          readonly start: number;
          // The pictures' height in this row, and each one's width, in order.
          readonly height: number;
          readonly widths: readonly number[];
      };

// A tile band as keyboard travel sees it: which band, and which stretch of home order it covers.
export interface HomeRow {
    readonly band: number;
    readonly start: number;
    readonly count: number;
    // A gallery row's pictures by where each stands across the row, its left and right edges from 0 to 1, since a
    // picture's place in a row says nothing of where it stands under the row above; absent for a grid row, whose
    // columns line up.
    readonly spans?: readonly (readonly [number, number])[];
}

export interface HomeLayout {
    readonly bands: readonly HomeBand[];
    // Band heights in the same order, for the window's metrics.
    readonly heights: readonly number[];
    // Tile bands only: the rows Up and Down move between. Label bands are not travelled to.
    readonly rows: readonly HomeRow[];
    readonly columns: number;
    // Tiles in total, which is `homeOrder(groups).length`.
    readonly count: number;
}

export interface HomeMetrics {
    // Tracks the grid resolves to at this width; at least one, so a narrow pane still lays out.
    readonly columns: number;
    // A tile row's full height, gap included: bands are placed by offset, so the gap has to live in the height.
    readonly tileHeight: number;
    readonly labelHeight: number;
}

/** What the home measures off its probe (HomeProbe.vue): the grid's metrics, and a gallery card's frame. */
export interface HomeProbed extends HomeMetrics {
    // The width a band fills.
    readonly width: number;
    // A gallery card's padding on each side, the gap between two cards, and what a card adds under its picture.
    readonly galleryPad: number;
    readonly galleryGap: number;
    readonly galleryCaption: number;
}

/** How a gallery lays its groups out; absent, every group is tiles. */
export interface HomeGallery extends GalleryMetrics {
    // Which groups are drawn as pictures; the rest (folders, a group of documents) stay tiles.
    readonly drawn: (group: HomeGroup) => boolean;
    // Each entry's width over its height, as it is to be laid out.
    readonly aspectOf: (entry: WorkspaceTreeEntry) => number;
    // Height a row adds under its pictures (the name) and below that (the gap to the next row).
    readonly captionHeight: number;
    readonly rowGap: number;
}

// Where each picture stands across the pane, for Up and Down to land on the one under the one they left.
const spansOf = (widths: readonly number[], gap: number, paneWidth: number): readonly (readonly [number, number])[] => {
    const across = Math.max(1, paneWidth);
    let left = 0;
    return widths.map((width) => {
        const span = [left / across, (left + width) / across] as const;
        left += width + gap;
        return span;
    });
};

export const EMPTY_LAYOUT: HomeLayout = { bands: [], heights: [], rows: [], columns: 1, count: 0 };

/**
 * Lay a folder's groups out as bands.
 *
 * @param groups The folder's entries, already grouped and sorted (`homeGroups`).
 * @param showLabels Whether group labels earn a band (`labelsShown`): a folder of one kind reads without them.
 */
export const homeLayout = (groups: readonly HomeGroup[], showLabels: boolean, metrics: HomeMetrics, gallery?: HomeGallery): HomeLayout => {
    const columns = Math.max(1, Math.floor(metrics.columns));
    const bands: HomeBand[] = [];
    const heights: number[] = [];
    const rows: HomeRow[] = [];
    let start = 0;
    for (const group of groups) {
        if (showLabels) {
            bands.push({ kind: `label`, key: `${group.key}#label`, label: group.label });
            heights.push(metrics.labelHeight);
        }
        if (gallery?.drawn(group) === true) {
            // The row's width is the pane's; how a row's own frame (the selection ring) fits inside it is the view's.
            for (const row of justifyRows(group.entries.map(gallery.aspectOf), gallery)) {
                const entries = group.entries.slice(row.start, row.start + row.widths.length);
                rows.push({
                    band: bands.length,
                    start: start + row.start,
                    count: entries.length,
                    spans: spansOf(row.widths, gallery.gap, gallery.width),
                });
                bands.push({
                    kind: `gallery`,
                    key: `${group.key}#${row.start}`,
                    entries,
                    start: start + row.start,
                    height: row.height,
                    widths: row.widths,
                });
                heights.push(row.height + gallery.captionHeight + gallery.rowGap);
            }
            start += group.entries.length;
            continue;
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

// Position in `rows` of the tile row holding a home-order index, by binary search; -1 when the index is out of range.
// The position, not the row: travel steps to `rows[at - 1]` and `rows[at + 1]`, which a row alone could not name.
export const rowIndexOf = (layout: HomeLayout, index: number): number => {
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

// Which band to render a given home-order index in, for scrolling a tile into view.
export const bandOfIndex = (layout: HomeLayout, index: number): number => {
    const at = rowIndexOf(layout, index);
    return at === -1 ? 0 : layout.rows[at]!.band;
};
