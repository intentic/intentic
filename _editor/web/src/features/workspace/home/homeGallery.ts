import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { formatOf } from "@intentic/ui/file-format";

// The home's gallery: a folder of pictures laid out in justified rows, the way photo libraries do it (Flickr's
// justified-layout, Google Photos). Every picture keeps its own shape, each row fills the pane's width exactly, and the
// rows all stand near one height, so the eye reads across a row rather than hunting down ragged columns. Pure, no DOM:
// the view hands in each picture's shape and the width it has.

/** A row of the gallery: which stretch of the entries, at what height, and how wide each picture in it is drawn. */
export interface GalleryRow {
    // Index of the row's first entry in the list laid out.
    readonly start: number;
    // Height of the pictures, not counting the name under them.
    readonly height: number;
    readonly widths: readonly number[];
}

export interface GalleryMetrics {
    // The width rows fill, in pixels.
    readonly width: number;
    // The height a row aims for; a justified row lands within a few tens of percent of it either way.
    readonly targetHeight: number;
    // Space between two pictures in a row.
    readonly gap: number;
}

// The shapes a picture may claim. Past these a full-page screenshot is a sliver and a panorama a ribbon taking a row
// alone, so either is drawn in a box at the bound and cropped (the tile keeps the top of a tall one, which is where a
// page starts). The quick look and the viewer show it whole.
export const MIN_ASPECT = 0.5;
export const MAX_ASPECT = 2.5;

export const clampAspect = (aspect: number): number =>
    Number.isFinite(aspect) && aspect > 0 ? Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect)) : 1;

// How far a full row may grow past the target height before it is cut a picture shorter instead. A row of two
// portrait shots in a wide pane would otherwise stand taller than the screen.
const MAX_GROWTH = 1.5;

/**
 * Break pictures of the given shapes (width over height) into justified rows.
 *
 * Greedy, with the one look-back that keeps rows even: once a row's pictures at the target height would overflow the
 * width, the row ends either just before or just after the picture that overflowed, whichever leaves its height
 * nearer the target. The last row is never stretched to fill; it stands at the target height, left-aligned, as a
 * partial line of text does.
 */
export const justifyRows = (aspects: readonly number[], metrics: GalleryMetrics): readonly GalleryRow[] => {
    const width = Math.max(1, metrics.width);
    const target = Math.max(1, metrics.targetHeight);
    const gap = Math.max(0, metrics.gap);
    const ratios = aspects.map(clampAspect);
    const rows: GalleryRow[] = [];
    // The height at which `count` pictures from `start` fill the width exactly.
    const fitHeight = (start: number, count: number): number => {
        let sum = 0;
        for (let at = start; at < start + count; at += 1) {
            sum += ratios[at]!;
        }
        return Math.max(1, width - gap * (count - 1)) / sum;
    };
    const rowAt = (start: number, count: number, height: number, justified: boolean): GalleryRow => {
        const widths = ratios.slice(start, start + count).map((ratio) => Math.floor(ratio * height));
        // Rounding each width down leaves a justified row a pixel or two short; the last picture takes them, so the
        // row's right edge is the pane's.
        if (justified && widths.length > 0) {
            const used = widths.reduce((sum, value) => sum + value, 0) + gap * (count - 1);
            widths[widths.length - 1] = Math.max(1, widths.at(-1)! + Math.round(width - used));
        }
        return { start, height: Math.round(height), widths };
    };
    let start = 0;
    while (start < ratios.length) {
        let count = 1;
        // Grow the row until the pictures at the target height no longer fit.
        while (start + count < ratios.length && fitHeight(start, count + 1) >= target) {
            count += 1;
        }
        if (start + count >= ratios.length && fitHeight(start, count) >= target) {
            // What is left fits at the target height without filling the row: the last line, drawn as it is.
            rows.push(rowAt(start, count, target, false));
            break;
        }
        // Either `count` pictures stand taller than the target, or `count + 1` stand shorter: keep the nearer.
        const without = fitHeight(start, count);
        const withNext = start + count < ratios.length ? fitHeight(start, count + 1) : undefined;
        if (withNext !== undefined && (Math.abs(withNext - target) < Math.abs(without - target) || without > target * MAX_GROWTH)) {
            count += 1;
        }
        const fit = fitHeight(start, count);
        rows.push(rowAt(start, count, Math.min(fit, target * MAX_GROWTH), fit <= target * MAX_GROWTH));
        start += count;
    }
    return rows;
};

/**
 * The long edge, in device pixels, a picture of proportions `aspect` needs to cover a box `width`×`height` CSS pixels
 * at `scale` device pixels each: as `object-fit: cover` draws it, as wide as the box or as tall, whichever leaves no
 * gap. Never longer than the picture's own long edge where that is known, since past it the daemon answers the same
 * pixels under another name.
 */
export const edgeNeeded = (width: number, height: number, aspect: number, scale: number, ownLong?: number): number => {
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    const drawnWidth = Math.max(width, height * ratio);
    const need = Math.ceil(Math.max(drawnWidth, drawnWidth / ratio) * scale);
    return ownLong === undefined ? need : Math.min(need, ownLong);
};

// How far a picture is enlarged to fill its box before it is drawn at its own size instead. A screenshot a little
// smaller than its box fills it, softer by a step; an icon or a favicon blown up four times over is a blur, and reads
// better small and sharp on the box's faint fill.
const MAX_ENLARGE = 2;

/** Whether a picture of its own `own` pixels would have to be enlarged past MAX_ENLARGE to cover a `width`×`height` box. */
export const tooSmallFor = (own: { readonly width: number; readonly height: number }, width: number, height: number): boolean =>
    own.width > 0 && own.height > 0 && Math.max(width / own.width, height / own.height) > MAX_ENLARGE;

// --- Which folders read as a gallery -------------------------------------------------------------------------------

/** What a gallery draws as itself: a picture or a video. Anything else in a gallery row is a card with its glyph. */
export type GalleryArt = "picture" | "video";

export const galleryArtOf = (entry: Pick<WorkspaceTreeEntry, "name" | "type">): GalleryArt | undefined => {
    if (entry.type === `dir`) {
        return undefined;
    }
    const { category } = formatOf(entry.name);
    return category === `image` ? `picture` : category === `video` ? `video` : undefined;
};

// A folder is a gallery when what it holds is mostly to be looked at: two pictures or videos at least, and two of every
// three files. Folders are not counted, since a gallery draws them as the tiles they are, above it. Two, not one: a
// lone screenshot beside a README is a project, not an album.
const MIN_ART = 2;
const ART_SHARE = 2 / 3;

export const readsAsGallery = (entries: readonly WorkspaceTreeEntry[]): boolean => {
    let files = 0;
    let art = 0;
    for (const entry of entries) {
        if (entry.type === `dir`) {
            continue;
        }
        files += 1;
        if (galleryArtOf(entry) !== undefined) {
            art += 1;
        }
    }
    return art >= MIN_ART && art >= files * ART_SHARE;
};

/** Whether a folder holds anything a gallery would draw, so the switch to one is worth offering. */
export const hasGalleryArt = (entries: readonly WorkspaceTreeEntry[]): boolean => entries.some((entry) => galleryArtOf(entry) !== undefined);

// --- Shapes ---------------------------------------------------------------------------------------------------------

// What a picture is drawn as before its own proportions are known: the folder's typical ones, so a row laid out early
// is close to the row it becomes. A video's default is the screen's; a card with a glyph is square.
const DEFAULT_PICTURE = 4 / 3;
const DEFAULT_VIDEO = 16 / 9;

/** The median of the shapes known so far, the guess for the ones not yet measured; undefined when none is. */
export const typicalAspect = (known: readonly number[]): number | undefined => {
    if (known.length === 0) {
        return undefined;
    }
    const sorted = known.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The shape a gallery lays an entry out at: its own when known, else the folder's typical, else its kind's default. */
export const aspectFor = (entry: Pick<WorkspaceTreeEntry, "name" | "type">, known: number | undefined, typical: number | undefined): number => {
    const art = galleryArtOf(entry);
    if (art === undefined) {
        return 1;
    }
    return known ?? typical ?? (art === `video` ? DEFAULT_VIDEO : DEFAULT_PICTURE);
};
