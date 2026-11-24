import type { StorageCategoryId, StorageCategoryUsage, StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import { cleanOffer, uncountedBytes } from "./storageView";

// How the Disk card draws a scan as a map (2026-11-24): the whole volume as one bar, the sandbox's own share of it
// opened into a treemap whose tiles are as big as what they hold, each coloured by what the reader can do about it.
// Pure, so the card and its tests read the same figures.

// What the reader can do about a category: clean it from here, look after it themselves (their files, their
// conversations and the copies those work in), or leave it to the sandbox, which needs it to run.
export type DiskGroup = `free` | `yours` | `own`;
export const DISK_GROUPS: readonly DiskGroup[] = [`free`, `yours`, `own`];

const YOURS: ReadonlySet<StorageCategoryId> = new Set([`workspace`, `conversations`, `checkouts`, `repositories`, `restorePoints`]);

export const groupOf = ({ id, cleanability }: Pick<StorageCategoryUsage, "id" | "cleanability">): DiskGroup =>
    cleanability !== `none` ? `free` : YOURS.has(id) ? `yours` : `own`;

// One colour per group, the same on the bar, the tiles, the legend and a category's page. The cleanable side wears the
// accent: it is the part of the disk the card can give back.
export const GROUP_SWATCH = { free: `bg-primary-fill`, yours: `bg-content/25`, own: `bg-content/12` } as const satisfies Record<DiskGroup, string>;

export const groupBytes = (categories: readonly StorageCategoryUsage[], group: DiskGroup): number =>
    categories.reduce((total, category) => (groupOf(category) === group ? total + category.bytes : total), 0);

// One stretch of the whole-disk bar, as fractions of the volume: each group the scan counted, then what the volume
// reports used that no category holds. The free space is the track the bar is drawn on.
export interface DiskSegment {
    readonly key: DiskGroup | `outside`;
    readonly bytes: number;
    readonly start: number;
    readonly size: number;
}

// Absent when the volume would not say how big it is. The categories can span volumes and count a file twice
// where it is linked, so the stretches are clipped to the bar rather than trusted to fit it.
export const diskSegments = (scan: StorageScan): readonly DiskSegment[] | undefined => {
    const total = scan.disk?.totalBytes ?? 0;
    if (total <= 0) {
        return undefined;
    }
    const parts: readonly (readonly [DiskSegment[`key`], number])[] = [
        ...DISK_GROUPS.map((group) => [group, groupBytes(scan.categories, group)] as const),
        [`outside`, uncountedBytes(scan) ?? 0],
    ];
    const segments: DiskSegment[] = [];
    let start = 0;
    for (const [key, bytes] of parts) {
        const size = Math.min(1 - start, bytes / total);
        if (size > 0) {
            segments.push({ key, bytes, start, size });
            start += size;
        }
    }
    return segments;
};

// The sandbox's own share of the bar, where the treemap under it zooms in from.
export const sandboxShare = (segments: readonly DiskSegment[]): number =>
    segments.filter((segment) => segment.key !== `outside`).reduce((end, segment) => Math.max(end, segment.start + segment.size), 0);

// A tile of the map: one category, or the categories too small to name folded into one.
export type DiskTile =
    | { readonly kind: `category`; readonly id: StorageCategoryId; readonly group: DiskGroup; readonly bytes: number }
    | { readonly kind: `smaller`; readonly ids: readonly StorageCategoryId[]; readonly bytes: number };

// Under this share of what the scan counted a category folds into the one "smaller" tile: below about a hundredth a
// tile is too small to name, and soon too small to press.
const SMALL_SHARE = 0.01;

export const mapTiles = (categories: readonly StorageCategoryUsage[]): readonly DiskTile[] => {
    const counted = categories.reduce((total, category) => total + category.bytes, 0);
    const sorted = categories.filter((category) => category.bytes > 0).toSorted((a, b) => b.bytes - a.bytes);
    const small = sorted.filter((category) => category.bytes / counted < SMALL_SHARE);
    // Folding a single category saves no room and hides its name, so a tail of one keeps its own tile.
    const named = small.length > 1 ? sorted.filter((category) => !small.includes(category)) : sorted;
    const tiles: DiskTile[] = named.map((category) => ({ kind: `category`, id: category.id, group: groupOf(category), bytes: category.bytes }));
    if (small.length > 1) {
        tiles.push({ kind: `smaller`, ids: small.map((category) => category.id), bytes: small.reduce((total, category) => total + category.bytes, 0) });
    }
    return tiles;
};

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

// Rectangles whose areas are the items' sizes, filling width × height (Bruls, Huizing and van Wijk's squarified
// treemap): items, largest first, go into a row along the shorter side for as long as that keeps the row's worst
// rectangle closer to a square, and each finished row takes its strip off the room left.
export const squarify = <T extends { readonly bytes: number }>(items: readonly T[], width: number, height: number): readonly (T & Rect)[] => {
    const total = items.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);
    if (total <= 0 || width <= 0 || height <= 0) {
        return [];
    }
    const scale = (width * height) / total;
    const out: (T & Rect)[] = [];
    let x = 0;
    let y = 0;
    let w = width;
    let h = height;
    // The worst aspect ratio a row would have laid along a side of this length.
    const worst = (row: readonly { readonly area: number }[], side: number): number => {
        const sum = row.reduce((acc, cell) => acc + cell.area, 0);
        const largest = Math.max(...row.map((cell) => cell.area));
        const smallest = Math.min(...row.map((cell) => cell.area));
        return Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
    };
    const lay = (row: readonly { readonly item: T; readonly area: number }[]): void => {
        const sum = row.reduce((acc, cell) => acc + cell.area, 0);
        if (w >= h) {
            // A column down the left of the room left.
            const columnWidth = sum / h;
            let top = y;
            for (const cell of row) {
                const cellHeight = cell.area / columnWidth;
                out.push({ ...cell.item, x, y: top, w: columnWidth, h: cellHeight });
                top += cellHeight;
            }
            x += columnWidth;
            w -= columnWidth;
        } else {
            // A row across the top of the room left.
            const rowHeight = sum / w;
            let left = x;
            for (const cell of row) {
                const cellWidth = cell.area / rowHeight;
                out.push({ ...cell.item, x: left, y, w: cellWidth, h: rowHeight });
                left += cellWidth;
            }
            y += rowHeight;
            h -= rowHeight;
        }
    };
    let row: { readonly item: T; readonly area: number }[] = [];
    for (const item of items) {
        const cell = { item, area: Math.max(0, item.bytes) * scale };
        if (row.length > 0 && worst([...row, cell], Math.min(w, h)) > worst(row, Math.min(w, h))) {
            lay(row);
            row = [];
        }
        row.push(cell);
    }
    if (row.length > 0) {
        lay(row);
    }
    return out;
};

// What can be cleaned now, one line each in the clean-up list, the most it would give back first. A store whose own
// tool decides what goes (a package store) names no figure, so it ranks, and is offered, by its whole size.
export interface CleanChoice {
    readonly id: StorageCategoryId;
    readonly bytes: number;
    // The figure is what cleaning frees, not the most it could.
    readonly exact: boolean;
    // Cleaning it costs something that does not come back; the list leaves it unticked until the reader ticks it.
    readonly confirm: boolean;
}

export const cleanChoices = (categories: readonly StorageCategoryUsage[]): readonly CleanChoice[] =>
    categories
        .flatMap((category): CleanChoice[] => {
            const offer = cleanOffer(category);
            return offer.kind === `clean`
                ? [{ id: category.id, bytes: offer.bytes ?? category.bytes, exact: offer.bytes !== undefined, confirm: offer.confirm }]
                : [];
        })
        .toSorted((a, b) => b.bytes - a.bytes);

export const choiceBytes = (choices: readonly CleanChoice[]): number => choices.reduce((total, choice) => total + choice.bytes, 0);
