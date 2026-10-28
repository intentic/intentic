import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { type GalleryMetrics, justifyRows, sharedStart } from "./gallery/homeGallery";
import type { HomeGroup } from "./homeOrder";

// The home's tiles as a list of fixed-height bands: a group label, or one row of tiles. Turning the grid into a list is
// what lets the home window itself — a folder of fifty thousand files then paints the dozen rows on screen and no more.
// Pure, no DOM: the view measures the column count and the band heights off a probe and hands them in, so the CSS stays
// the single source of truth for both. In a gallery a group of pictures is laid out as justified rows (homeGallery.ts)
// instead: still bands, each one row, only each its own height; and the folders above it as a strip of one-line chips, so
// the pictures have the screen rather than a row of large glyphs.

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
          // The start every name in the group shares, which a caption gives up first (`sharedStart`).
          readonly shared: string;
      }
    | {
          // Folders above a gallery, each a one-line chip in a grid of its own columns.
          readonly kind: "chips";
          readonly key: string;
          readonly entries: readonly WorkspaceTreeEntry[];
          readonly start: number;
          readonly columns: number;
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
    // The folder chips' grid above a gallery: its column count at this width, and a row's height, gap included.
    readonly chipColumns: number;
    readonly chipHeight: number;
}

/** What the home lays out by before its probe has measured anything: one column, nothing tall. */
export const UNPROBED: HomeProbed = {
    columns: 1,
    tileHeight: 1,
    labelHeight: 0,
    width: 0,
    galleryPad: 0,
    galleryGap: 0,
    galleryCaption: 0,
    chipColumns: 1,
    chipHeight: 1,
};

/** How a gallery lays its groups out; absent, every group is tiles. */
export interface HomeGallery extends GalleryMetrics {
    // Which groups are drawn as pictures; the rest (folders, a group of documents) stay tiles.
    readonly drawn: (group: HomeGroup) => boolean;
    // Each entry's width over its height, as it is to be laid out.
    readonly aspectOf: (entry: WorkspaceTreeEntry) => number;
    // Height a row adds under its pictures (the name) and below that (the gap to the next row).
    readonly captionHeight: number;
    readonly rowGap: number;
    // The folders as chips (the "folders" group); absent, they stay tiles.
    readonly chips?: { readonly columns: number; readonly height: number };
}

// Where each of a row's even columns stands across the pane, for Up and Down out of a chip row into a gallery row.
const evenSpans = (count: number, columns: number): readonly (readonly [number, number])[] =>
    Array.from({ length: count }, (_, column) => [column / columns, (column + 1) / columns] as const);

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
        if (gallery?.chips !== undefined && group.key === `folders`) {
            const across = Math.max(1, Math.floor(gallery.chips.columns));
            for (let at = 0; at < group.entries.length; at += across) {
                const entries = group.entries.slice(at, at + across);
                rows.push({ band: bands.length, start: start + at, count: entries.length, spans: evenSpans(entries.length, across) });
                bands.push({ kind: `chips`, key: `${group.key}#${at}`, entries, start: start + at, columns: across });
                heights.push(gallery.chips.height);
            }
            start += group.entries.length;
            continue;
        }
        if (gallery?.drawn(group) === true) {
            const shared = sharedStart(group.entries.map((entry) => entry.name));
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
                    shared,
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

// How a band of tiles is boxed, by what it holds: a gallery row lays its pictures side by side at their own widths, a
// chip row and a tile row are grids, of their own columns or of the home's.
export const BAND_LOOK = { gallery: `flex gap-1`, chips: `grid gap-1.5`, tiles: `grid gap-0.5` } as const;
export const bandColumns = (band: Exclude<HomeBand, { kind: "label" }>, columns: number): { gridTemplateColumns?: string } =>
    band.kind === `gallery` ? {} : { gridTemplateColumns: `repeat(${band.kind === `chips` ? band.columns : columns}, minmax(0, 1fr))` };

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
