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

// What the checker reads: the page's text, rows kept together so a label stands beside its value (@intentic/ocr).
export const readingText = pageText;

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
    return { before: Math.max(0, before), after: Math.max(0, after) };
};

interface Stretch {
    from: number;
    to: number;
    readonly token: string;
}

// The stretches of one line its spans cover, each reaching to the columns of the characters around it (the ink of a
// glyph starts before the column it was read in), sorted along the line.
const stretchesOn = (line: OcrLine, lineStart: number, spans: readonly ImageSpan[]): Stretch[] => {
    const symbols = symbolIndex(line);
    const lineEnd = lineStart + line.text.length;
    const stretches: Stretch[] = [];
    for (const span of spans) {
        const start = Math.max(span.start, lineStart) - lineStart;
        const end = Math.min(span.end, lineEnd) - lineStart;
        if (end <= start) {
            continue;
        }
        const first = symbols[start] ?? 0;
        const last = symbols[end - 1] ?? line.chars.length - 1;
        const before = line.chars[first - 1];
        const after = line.chars[last + 1];
        stretches.push({
            from: before === undefined ? 0 : Math.max(0, before.to - line.column),
            to: after === undefined ? 1 : Math.min(1, after.from + line.column),
            token: span.token,
        });
    }
    return stretches.toSorted((left, right) => left.from - right.from);
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
    const regions: MaskRegion[] = [];
    let lineStart = 0;
    for (const line of lines) {
        const stretches = stretchesOn(line, lineStart, spans);
        lineStart += line.text.length + 1;
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
