import sharp from "sharp";
import { distance, fillPolygon, type Point, type Quad } from "@intentic/ocr/geometry";
import { type OcrLine, pageText, stretchOf } from "@intentic/ocr/paddle-ocr";
import { decodeImage } from "@intentic/ocr/raster";
import { GLYPH_HEIGHT, textCoverage, textUnits } from "./token-glyphs.js";

// An image bound for an untrusted provider, sent with its personal data painted over: the text read off it on this
// machine is checked like any other text, and each stretch of a line the checker finds is covered and labelled with the
// token the value was given, so the model still sees the picture and can name what it cannot read. The tokens come
// back in its answer and are put back on this machine, as they are for text.

// What one stretch of read text was found to be: offsets into `readingText(lines)`, and its token.
export interface ImageSpan {
    readonly start: number;
    readonly end: number;
    readonly token: string;
}

// Where on the image a token goes, and which.
export interface MaskRegion {
    readonly corners: Quad;
    readonly token: string;
}

// How tall a token is drawn against its line's thickness, and the smallest font unit it shrinks to before it would
// rather cover more of its line: under that, the lettering stops being something a model can read.
const INK_SHARE = 0.72;
const MIN_UNIT = 1.4;
// Gaps kept from a neighbouring line when a token spills into free space.
const CLEARANCE = 2;

// For each UTF-16 offset of a line's text, the index of the recognizer symbol it belongs to.
const symbolIndex = (line: Pick<OcrLine, "chars">): number[] =>
    line.chars.flatMap((char, index) => [...char.char].flatMap((codePoint) => (codePoint.length === 2 ? [index, index] : [index])));

const lengthOf = (line: Pick<OcrLine, "corners" | "vertical">): number =>
    line.vertical ? distance(line.corners[0], line.corners[3]) : distance(line.corners[0], line.corners[1]);
const thicknessOf = (line: Pick<OcrLine, "corners" | "vertical">): number =>
    line.vertical ? distance(line.corners[0], line.corners[1]) : distance(line.corners[0], line.corners[3]);

interface Box {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
}
const boxOf = (corners: Quad): Box => ({
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y)),
});

interface Extent {
    readonly start: number;
    readonly end: number;
}

// One line's place in the reading text: which line, and where its text starts.
interface Placement {
    readonly line: number;
    readonly start: number;
}

// The reading text, and where every line sits in it: once in the rows, and again in its block when it wraps. Finds at
// or past `blocks` were made in the blocks.
interface Layout {
    readonly text: string;
    readonly placements: readonly Placement[];
    readonly blocks: number;
}

// A line goes on in the one below it, as a table cell's or a paragraph's words wrap: the same way up and the same size,
// on the next line down, lined up with it at its start, its end or its middle. Measured in the upper line's own frame, so
// a page read upside down or turned a little wraps alike. Rows of a dense table pass too: a block joined that was never
// one costs nothing, since only what reads across a join is taken from it (distinctFinds).
const LINE_GAP = 0.75;
const SIZE_RATIO = 1.5;

const wrapsInto = (upper: OcrLine, lower: OcrLine): boolean => {
    if (upper.vertical || lower.vertical) {
        return false;
    }
    const [origin, end, , bottom] = upper.corners;
    const length = distance(origin, end);
    const height = distance(origin, bottom);
    const lowerHeight = thicknessOf(lower);
    if (length === 0 || height === 0 || lowerHeight === 0 || Math.max(height, lowerHeight) / Math.min(height, lowerHeight) > SIZE_RATIO) {
        return false;
    }
    const along = { x: (end.x - origin.x) / length, y: (end.y - origin.y) / length };
    const down = { x: (bottom.x - origin.x) / height, y: (bottom.y - origin.y) / height };
    const [lowerOrigin, lowerEnd] = lower.corners;
    const lowerLength = lengthOf(lower);
    if (lowerLength === 0 || ((lowerEnd.x - lowerOrigin.x) * along.x + (lowerEnd.y - lowerOrigin.y) * along.y) / lowerLength < 0.95) {
        return false;
    }
    const projected = lower.corners.map((point) => ({
        along: (point.x - origin.x) * along.x + (point.y - origin.y) * along.y,
        down: (point.x - origin.x) * down.x + (point.y - origin.y) * down.y,
    }));
    const top = Math.min(...projected.map((point) => point.down));
    const start = Math.min(...projected.map((point) => point.along));
    const finish = Math.max(...projected.map((point) => point.along));
    const slack = Math.min(height, lowerHeight);
    const lined = Math.abs(start) <= slack || Math.abs(finish - length) <= slack || Math.abs((start + finish) / 2 - length / 2) <= slack;
    return lined && top >= height / 2 && top - height <= LINE_GAP * slack;
};

// What joins a line to the one it wraps into: nothing after a hyphen that splits a word or a number ("30-" over "059
// Kraków"), a space otherwise.
const joinerOf = (upper: OcrLine, lower: OcrLine | undefined): string => {
    if (lower === undefined) {
        return "";
    }
    return upper.text.endsWith("-") && /^[\p{L}\p{N}]/u.test(lower.text) ? "" : " ";
};

// Kept per reading: an image's lines are the same array every request of a conversation re-sends it with (the gateway's
// reading memo), and the text, the finds and the regions are each laid out from them.
const layouts = new WeakMap<readonly OcrLine[], Layout>();

const layoutOf = (lines: readonly OcrLine[]): Layout => {
    const kept = layouts.get(lines);
    if (kept !== undefined) {
        return kept;
    }
    const placements: Placement[] = [];
    let start = 0;
    for (const [index, line] of lines.entries()) {
        placements.push({ line: index, start });
        start += line.text.length + 1;
    }
    // Each line's next one down: the first in reading order that it wraps into and that no line above took already, so
    // every line has at most one line before it and the blocks never loop.
    const next = new Map<number, number>();
    const taken = new Set<number>();
    for (const [index, line] of lines.entries()) {
        const below = lines.findIndex((other, at) => at !== index && !taken.has(at) && wrapsInto(line, other));
        if (below !== -1) {
            next.set(index, below);
            taken.add(below);
        }
    }
    let text = pageText(lines);
    const blocks = text.length + 1;
    for (const head of next.keys()) {
        if (taken.has(head)) {
            continue;
        }
        text += "\n";
        let at: number | undefined = head;
        let line = lines[head];
        while (at !== undefined && line !== undefined) {
            const following = next.get(at);
            const after = following === undefined ? undefined : lines[following];
            placements.push({ line: at, start: text.length });
            text += line.text + joinerOf(line, after);
            at = following;
            line = after;
        }
    }
    const layout = { text, placements, blocks };
    layouts.set(lines, layout);
    return layout;
};

// The stretch of each line a span covers, in that line's own offsets.
const piecesOf = (layout: Layout, lines: readonly OcrLine[], span: Extent): (Extent & { readonly line: number })[] =>
    layout.placements.flatMap(({ line, start }) => {
        const from = Math.max(span.start, start);
        const to = Math.min(span.end, start + (lines[line]?.text.length ?? 0));
        return to > from ? [{ line, start: from - start, end: to - start }] : [];
    });

// What the checker reads: the page's rows as @intentic/ocr reads them (pageText: a label beside its value, a table's
// cells apart), then every block of lines that wrap into each other again, joined as the words they are. A value a
// table cell or a paragraph wraps (an IBAN over two lines of its cell, a postal code above its town) is broken up in
// the rows, where the cells beside it come between its pieces; in its block it reads whole.
export const readingText = (lines: readonly OcrLine[]): string => layoutOf(lines).text;

// The finds in readingText(lines) that each stand for a value once. The blocks repeat the rows' words, so a find made
// in a block counts only where it reads across a join and no find in the rows covers it already; a find in the rows
// that one across a join covers is left to that one ("ul. Lipowa 12/4" to "ul. Lipowa 12/4, 00-901 Warszawa").
export const distinctFinds = <S extends Extent>(lines: readonly OcrLine[], spans: readonly S[]): S[] => {
    const layout = layoutOf(lines);
    const pieced = spans.map((span) => ({ span, pieces: piecesOf(layout, lines, span), inBlock: span.start >= layout.blocks }));
    const covers = (outer: (typeof pieced)[number], inner: (typeof pieced)[number]): boolean =>
        inner.pieces.every((piece) => outer.pieces.some((each) => each.line === piece.line && each.start <= piece.start && each.end >= piece.end));
    const rows = pieced.filter((each) => !each.inBlock);
    const joined = pieced.filter(
        (each) => each.inBlock && new Set(each.pieces.map((piece) => piece.line)).size > 1 && !rows.some((row) => covers(row, each)),
    );
    return [...rows.filter((row) => !joined.some((each) => covers(each, row))), ...joined].map((each) => each.span);
};

// How far, in pixels, a horizontal line can be extended before its start and past its end without touching another
// line of text or leaving the picture: room a token may take without covering anything legible.
const freeRoom = (line: OcrLine, lines: readonly OcrLine[], bounds: { readonly width: number }): { readonly before: number; readonly after: number } => {
    if (line.vertical) {
        return { before: 0, after: 0 };
    }
    const own = boxOf(line.corners);
    let before = own.left;
    let after = bounds.width - own.right;
    for (const other of lines) {
        if (other === line) {
            continue;
        }
        const box = boxOf(other.corners);
        if (box.top >= own.bottom || box.bottom <= own.top) {
            continue;
        }
        if (box.left >= own.right - 1) {
            after = Math.min(after, box.left - own.right - CLEARANCE);
        } else if (box.right <= own.left + 1) {
            before = Math.min(before, own.left - box.right - CLEARANCE);
        }
    }
    // A line read upside down starts at the right of its box, so its room before is the picture's room to the right.
    const room = { before: Math.max(0, before), after: Math.max(0, after) };
    return line.corners[1].x < line.corners[0].x ? { before: room.after, after: room.before } : room;
};

interface Stretch {
    from: number;
    to: number;
    readonly token: string;
}

// The stretches of one line its pieces cover (offsets into the line's own text), each reaching to the columns of the
// characters around it (the ink of a glyph starts before the column it was read in), sorted along the line. Pieces that
// overlap, a line's words found once in its row and again in its block, are covered as one, under the wider one's token.
const stretchesOn = (line: OcrLine, pieces: readonly ImageSpan[]): Stretch[] => {
    const symbols = symbolIndex(line);
    const stretches: Stretch[] = [];
    for (const { start, end, token } of pieces) {
        const first = symbols[start] ?? 0;
        const last = symbols[end - 1] ?? line.chars.length - 1;
        const before = line.chars[first - 1];
        const after = line.chars[last + 1];
        stretches.push({
            from: before === undefined ? 0 : Math.max(0, before.to - line.column),
            to: after === undefined ? 1 : Math.min(1, after.from + line.column),
            token,
        });
    }
    const merged: Stretch[] = [];
    for (const stretch of stretches.toSorted((left, right) => left.from - right.from)) {
        const last = merged.at(-1);
        if (last === undefined || stretch.from >= last.to) {
            merged.push(stretch);
            continue;
        }
        const wider = stretch.to - stretch.from > last.to - last.from ? stretch : last;
        merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, stretch.to), token: wider.token };
    }
    return merged;
};

// The nearest word boundary at or after `at` along the line (the start of the next space), or `limit`.
const wordEndAfter = (line: OcrLine, at: number, limit: number): number => {
    const space = line.chars.find((char) => char.char.trim() === "" && char.from >= at);
    return space === undefined ? limit : Math.min(limit, space.from);
};
// The nearest word boundary at or before `at` (the end of the previous space), or `limit`.
const wordStartBefore = (line: OcrLine, at: number, limit: number): number => {
    const space = line.chars.findLast((char) => char.char.trim() === "" && char.to <= at);
    return space === undefined ? limit : Math.max(limit, space.to);
};

// Where every span's token goes. A token is lettered at its line's own size where it fits; where it does not, it
// first spills into free space before the line's start or past its end, then shrinks to the smallest readable size,
// and only then covers more of its own line, whole words at a time and never a neighbouring stretch.
export const regionsFor = (lines: readonly OcrLine[], spans: readonly ImageSpan[], bounds: { readonly width: number }): MaskRegion[] => {
    const layout = layoutOf(lines);
    const pieces = lines.map((): ImageSpan[] => []);
    for (const span of spans) {
        for (const { line, start, end } of piecesOf(layout, lines, span)) {
            pieces[line]?.push({ start, end, token: span.token });
        }
    }
    const regions: MaskRegion[] = [];
    for (const [at, line] of lines.entries()) {
        const stretches = stretchesOn(line, pieces[at] ?? []);
        const length = lengthOf(line);
        if (stretches.length === 0 || length === 0) {
            continue;
        }
        const room = freeRoom(line, lines, bounds);
        const unit = (thicknessOf(line) * INK_SHARE) / GLYPH_HEIGHT;
        stretches.forEach((stretch, index) => {
            const previous = stretches[index - 1];
            const next = stretches[index + 1];
            const low = previous?.to ?? -room.before / length;
            const high = next?.from ?? 1 + room.after / length;
            const width = (): number => stretch.to - stretch.from;
            const ideal = (textUnits(stretch.token) * unit) / length;
            const readable = (textUnits(stretch.token) * Math.min(unit, MIN_UNIT)) / length;
            if (width() < ideal && next === undefined && stretch.to >= 1) {
                stretch.to = Math.min(high, stretch.from + ideal);
            }
            if (width() < ideal && previous === undefined && stretch.from <= 0) {
                stretch.from = Math.max(low, stretch.to - ideal);
            }
            if (width() < readable) {
                stretch.to = wordEndAfter(line, stretch.from + readable, high);
            }
            if (width() < readable) {
                stretch.from = wordStartBefore(line, stretch.to - readable, low);
            }
            regions.push({ corners: stretchOf(line, stretch.from, stretch.to), token: stretch.token });
        });
    }
    return regions;
};

const centroid = (corners: Quad): Point => ({
    x: corners.reduce((sum, point) => sum + point.x, 0) / 4,
    y: corners.reduce((sum, point) => sum + point.y, 0) / 4,
});

export interface PaintedImage {
    readonly mediaType: string;
    // Base64.
    readonly data: string;
}

// The image with every region filled white and its token lettered in black, re-encoded: a JPEG stays a JPEG, anything
// else becomes a PNG. Undefined for bytes that do not decode. The same image and regions always give the same bytes.
export const paintRegions = async (data: Buffer, regions: readonly MaskRegion[]): Promise<PaintedImage | undefined> => {
    const decoded = await decodeImage(data);
    if (decoded === undefined) {
        return undefined;
    }
    const { width, height, data: pixels } = decoded.rgba;
    const paint = (x: number, y: number, value: number, coverage: number): void => {
        if (x < 0 || y < 0 || x >= width || y >= height) {
            return;
        }
        const at = (y * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
            pixels[at + c] = Math.round((pixels[at + c] ?? 0) * (1 - coverage) + value * coverage);
        }
        pixels[at + 3] = 255;
    };
    for (const region of regions) {
        // One pixel more on every side than the line's own box, so no antialiased edge of a covered glyph survives.
        const center = centroid(region.corners);
        const padded = region.corners.map((point) => {
            const dx = point.x - center.x;
            const dy = point.y - center.y;
            const reach = Math.hypot(dx, dy) || 1;
            return { x: point.x + dx / reach, y: point.y + dy / reach };
        });
        fillPolygon(padded, { width, height }, (y, fromX, toX) => {
            for (let x = fromX; x <= toX; x += 1) {
                paint(x, y, 255, 1);
            }
        });
        const along = distance(region.corners[0], region.corners[1]);
        const across = distance(region.corners[0], region.corners[3]);
        const units = textUnits(region.token);
        const unit = Math.min((along * 0.96) / Math.max(units, 1), (across * INK_SHARE) / GLYPH_HEIGHT);
        const origin = { x: center.x - (units * unit) / 2, y: center.y - (GLYPH_HEIGHT * unit) / 2 };
        textCoverage(region.token, origin, unit, (x, y, coverage) => paint(x, y, 0, coverage));
    }
    const raw = sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), { raw: { width, height, channels: 4 } });
    if (decoded.format === "jpeg") {
        const jpeg = await raw.removeAlpha().jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
        return { mediaType: "image/jpeg", data: jpeg.toString("base64") };
    }
    const png = await (decoded.hasAlpha ? raw : raw.removeAlpha()).png({ compressionLevel: 6 }).toBuffer();
    return { mediaType: "image/png", data: png.toString("base64") };
};
