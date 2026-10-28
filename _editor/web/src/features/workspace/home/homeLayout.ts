import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { type GalleryMetrics, justifyRows, sharedStart } from "./gallery/homeGallery";
import { displayOf, type HomeDisplay, type HomeGroup } from "./homeOrder";

// The home's tiles as a list of fixed-height bands: a group label, or one row of tiles. Turning the grid into a list is
// what lets the home window itself — a folder of fifty thousand files then paints the dozen rows on screen and no more.
// Pure, no DOM: the view measures the column count and the band heights off a probe and hands them in, so the CSS stays
// the single source of truth for both. Each entry is drawn by what it can show (homeOrder.ts `displayOf`): a folder or a
// file with nothing inside worth showing as a one-line chip, a file read from its start as a card with a miniature of
// that start, a picture or a video as a tile, or, in a gallery, in justified rows (homeGallery.ts): still bands, each one
// row, only each its own height.

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
          // One-line chips (folders, and files with nothing inside to show), or preview cards, each in a grid of its own
          // columns.
          readonly kind: "chips" | "cards";
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
    // The chips' grid: its column count at this width, and a row's height, gap included.
    readonly chipColumns: number;
    readonly chipHeight: number;
    // The preview cards' grid, the same two.
    readonly cardColumns: number;
    readonly cardHeight: number;
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
    cardColumns: 1,
    cardHeight: 1,
};

/** How a gallery lays its pictures and videos out; absent, they are tiles. */
export interface HomeGallery extends GalleryMetrics {
    // Each entry's width over its height, as it is to be laid out.
    readonly aspectOf: (entry: WorkspaceTreeEntry) => number;
    // Height a row adds under its pictures (the name) and below that (the gap to the next row).
    readonly captionHeight: number;
    readonly rowGap: number;
}

// Where each of a row's even columns stands across the pane, for Up and Down between a chip row and a row of another
// grid or a gallery row.
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

// The stretches of one display in a heading's entries, in order: [display, index of the first, entries].
const runsOf = (entries: readonly WorkspaceTreeEntry[]): readonly (readonly [HomeDisplay, number, readonly WorkspaceTreeEntry[]])[] => {
    const runs: [HomeDisplay, number, WorkspaceTreeEntry[]][] = [];
    entries.forEach((entry, at) => {
        const display = displayOf(entry);
        const last = runs.at(-1);
        if (last?.[0] === display) {
            last[2].push(entry);
        } else {
            runs.push([display, at, [entry]]);
        }
    });
    return runs;
};

interface Laid {
    readonly bands: HomeBand[];
    readonly heights: number[];
    readonly rows: HomeRow[];
}

interface Grid {
    readonly kind: `tiles` | `chips` | `cards`;
    readonly columns: number;
    readonly height: number;
}

// The grid a display that is not a gallery's is laid out on.
const gridOf = (display: HomeDisplay, metrics: HomeMetrics): Grid =>
    display === `visual`
        ? { kind: `tiles`, columns: metrics.columns, height: metrics.tileHeight }
        : display === `card`
          ? { kind: `cards`, columns: metrics.cardColumns, height: metrics.cardHeight }
          : { kind: `chips`, columns: metrics.chipColumns, height: metrics.chipHeight };

// A run as rows of a grid: the home's own tiles, whose columns line up with the rows' indices, or a grid of its own
// columns (chips, cards), whose rows say where each stands across the pane so Up and Down can cross into another grid.
const laidGrid = (
    entries: readonly WorkspaceTreeEntry[],
    start: number,
    key: string,
    grid: Grid,
    out: Laid,
): void => {
    const across = Math.max(1, Math.floor(grid.columns));
    for (let at = 0; at < entries.length; at += across) {
        const row = entries.slice(at, at + across);
        const laid: HomeRow = { band: out.bands.length, start: start + at, count: row.length };
        out.rows.push(grid.kind === `tiles` ? laid : { ...laid, spans: evenSpans(row.length, across) });
        // Keyed on the run and the row's first index, not on an entry: a rename must not re-key the whole band.
        out.bands.push(
            grid.kind === `tiles`
                ? { kind: `tiles`, key: `${key}#${at}`, entries: row, start: start + at }
                : { kind: grid.kind, key: `${key}#${at}`, entries: row, start: start + at, columns: across },
        );
        out.heights.push(grid.height);
    }
};

// A run of pictures as justified rows. The row's width is the pane's; how a row's own frame (the selection ring) fits
// inside it is the view's.
const laidGallery = (entries: readonly WorkspaceTreeEntry[], start: number, key: string, gallery: HomeGallery, out: Laid): void => {
    const shared = sharedStart(entries.map((entry) => entry.name));
    for (const row of justifyRows(entries.map(gallery.aspectOf), gallery)) {
        out.rows.push({
            band: out.bands.length,
            start: start + row.start,
            count: row.widths.length,
            spans: spansOf(row.widths, gallery.gap, gallery.width),
        });
        out.bands.push({
            kind: `gallery`,
            key: `${key}#${row.start}`,
            entries: entries.slice(row.start, row.start + row.widths.length),
            start: start + row.start,
            height: row.height,
            widths: row.widths,
            shared,
        });
        out.heights.push(row.height + gallery.captionHeight + gallery.rowGap);
    }
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
        // A heading's entries in runs of one display, each laid out its own way; a date heading holds its runs together
        // (homeOrder.ts), a kind heading is one run.
        for (const [display, from, entries] of runsOf(group.entries)) {
            const key = `${group.key}#${display}${from}`;
            if (display === `visual` && gallery !== undefined) {
                laidGallery(entries, start + from, key, gallery, { bands, heights, rows });
            } else {
                laidGrid(entries, start + from, key, gridOf(display, metrics), { bands, heights, rows });
            }
        }
        start += group.entries.length;
    }
    return { bands, heights, rows, columns, count: start };
};

// How a band of tiles is boxed, by what it holds: a gallery row lays its pictures side by side at their own widths, a
// chip row, a card row and a tile row are grids, of their own columns or of the home's. The gaps are HomeProbe.vue's.
export const BAND_LOOK = { gallery: `flex gap-1`, chips: `grid gap-1.5`, cards: `grid gap-2`, tiles: `grid gap-0.5` } as const;
export const bandColumns = (band: Exclude<HomeBand, { kind: "label" }>, columns: number): { gridTemplateColumns?: string } =>
    band.kind === `gallery` ? {} : { gridTemplateColumns: `repeat(${band.kind === `tiles` ? columns : band.columns}, minmax(0, 1fr))` };

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
