import type { Point, Quad } from "@intentic/ocr/geometry";
import type { OcrLine } from "@intentic/ocr/paddle-ocr";
import { distinctFinds, type MaskRegion, paintRegions, readingText } from "./image-mask.js";

// A PDF as the shield sends it while it masks: never as text. Every page is drawn on this machine, its words placed from
// the PDF's text layer and read off the picture wherever the layer does not account for what the page shows (a scan, a
// photo on the page, a form field, a stamp), its personal data painted over as a screenshot's is, and the pages bound
// again into a PDF of pictures alone. No text layer, metadata, form, annotation or attachment of the original reaches
// the provider: only what its pages show, checked.

// Two pixels to the point: a page's text-layer coordinates double into its picture's, and an A4 page is 1190 x 1684.
export const PDF_DPI = 144;

// One page as read: its picture's size, and every line on it in reading order.
export interface PdfPage {
    readonly width: number;
    readonly height: number;
    readonly lines: readonly OcrLine[];
}

export interface PdfReading {
    readonly pages: readonly PdfPage[];
    // Whether what the pages show beyond their text layer was read too (the text reader is installed). Without it only
    // the text layer was checked, which is enough only where pictures may go unchecked (the policy's images: allow).
    readonly pixels: boolean;
}

interface Box {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
}

interface LayerWord extends Box {
    readonly text: string;
}

// One page of `pdftotext -bbox-layout`: its size in points, and its lines, each a list of words.
export interface LayerPage {
    readonly width: number;
    readonly height: number;
    readonly lines: readonly (readonly LayerWord[])[];
}

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/giu;
const NAMED = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
]);
const unescape = (text: string): string =>
    text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
        if (name !== undefined) {
            return NAMED.get(name.toLowerCase()) ?? whole;
        }
        const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(decimal, 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });

const ATTRIBUTE = /(\w+)="([^"]*)"/gu;
const attributesOf = (tag: string): Record<string, number> =>
    Object.fromEntries([...tag.matchAll(ATTRIBUTE)].map(([, name, value]) => [name ?? "", Number(value)]));

const WORD = /<word ([^>]*)>([^<]*)<\/word>/gu;

// The pages of `pdftotext -bbox-layout` output (XHTML: page, flow, block, line, word, coordinates in points from the
// page's top left).
export const textLayerOf = (xhtml: string): LayerPage[] =>
    xhtml
        .split("<page ")
        .slice(1)
        .map((page) => {
            const size = attributesOf(page.slice(0, page.indexOf(">")));
            const lines = page
                .split("<line ")
                .slice(1)
                .map((line) =>
                    [...line.matchAll(WORD)].flatMap(([, attributes, text]) => {
                        const box = attributesOf(attributes ?? "");
                        const word = unescape(text ?? "").trim();
                        const { xMin = Number.NaN, yMin = Number.NaN, xMax = Number.NaN, yMax = Number.NaN } = box;
                        return word === "" || ![xMin, yMin, xMax, yMax].every(Number.isFinite) ? [] : [{ text: word, xMin, yMin, xMax, yMax }];
                    }),
                )
                .filter((words) => words.length > 0);
            return { width: size["width"] ?? 0, height: size["height"] ?? 0, lines };
        });

type Direction = "right" | "left" | "down" | "up";

// Which way a line reads, from its first word's middle to its last's; a line of one word reads across, unless it
// stands on its side, which is taken to read downwards.
const directionOf = (words: readonly LayerWord[], box: Box): Direction => {
    const first = words[0];
    const last = words.at(-1);
    if (first === undefined || last === undefined || first === last) {
        return box.xMax - box.xMin >= box.yMax - box.yMin ? "right" : "down";
    }
    const dx = (last.xMin + last.xMax - first.xMin - first.xMax) / 2;
    const dy = (last.yMin + last.yMax - first.yMin - first.yMax) / 2;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "down" : "up";
};

// One line of the text layer as the reader would report it, in the picture's pixels: its corners as its text reads
// (the first at its start), and each character placed along it, a word's characters sharing its width evenly.
const layerLine = (words: readonly LayerWord[], scale: { readonly x: number; readonly y: number }): OcrLine => {
    const box = {
        xMin: Math.min(...words.map((word) => word.xMin)),
        yMin: Math.min(...words.map((word) => word.yMin)),
        xMax: Math.max(...words.map((word) => word.xMax)),
        yMax: Math.max(...words.map((word) => word.yMax)),
    };
    const direction = directionOf(words, box);
    const at = (x: number, y: number): Point => ({ x: x * scale.x, y: y * scale.y });
    const corners: Quad = {
        right: [at(box.xMin, box.yMin), at(box.xMax, box.yMin), at(box.xMax, box.yMax), at(box.xMin, box.yMax)] as const,
        left: [at(box.xMax, box.yMax), at(box.xMin, box.yMax), at(box.xMin, box.yMin), at(box.xMax, box.yMin)] as const,
        down: [at(box.xMin, box.yMin), at(box.xMax, box.yMin), at(box.xMax, box.yMax), at(box.xMin, box.yMax)] as const,
        up: [at(box.xMin, box.yMax), at(box.xMax, box.yMax), at(box.xMax, box.yMin), at(box.xMin, box.yMin)] as const,
    }[direction];
    const across = direction === "right" || direction === "left";
    const length = across ? box.xMax - box.xMin : box.yMax - box.yMin;
    // A word's start and end along the line, as fractions of it.
    const extent = (word: LayerWord): { readonly from: number; readonly to: number } => {
        const [low, high] = {
            right: [word.xMin - box.xMin, word.xMax - box.xMin],
            left: [box.xMax - word.xMax, box.xMax - word.xMin],
            down: [word.yMin - box.yMin, word.yMax - box.yMin],
            up: [box.yMax - word.yMax, box.yMax - word.yMin],
        }[direction];
        return length <= 0 ? { from: 0, to: 1 } : { from: (low ?? 0) / length, to: (high ?? length) / length };
    };
    const chars: { char: string; from: number; to: number }[] = [];
    words.forEach((word, index) => {
        const { from, to } = extent(word);
        const previous = chars.at(-1);
        if (index > 0 && previous !== undefined) {
            chars.push({ char: " ", from: previous.to, to: Math.max(previous.to, from) });
        }
        const symbols = [...word.text];
        symbols.forEach((char, place) => {
            chars.push({ char, from: from + ((to - from) * place) / symbols.length, to: from + ((to - from) * (place + 1)) / symbols.length });
        });
    });
    return {
        text: words.map((word) => word.text).join(" "),
        score: 1,
        corners,
        chars,
        // A quarter of a character: the text layer's boxes hold their glyphs, so a stretch reaches only a little past them.
        column: 1 / (4 * Math.max(1, chars.length)),
        vertical: !across,
    };
};

// A page's text layer in its picture's pixels, or undefined when the picture is not the page the layer describes (a
// size that does not scale to it, as a page turned by its own /Rotate in only one of the two could be).
export const layerLines = (layer: LayerPage, picture: { readonly width: number; readonly height: number }): OcrLine[] | undefined => {
    if (layer.width <= 0 || layer.height <= 0) {
        return undefined;
    }
    const scale = { x: picture.width / layer.width, y: picture.height / layer.height };
    return Math.abs(scale.x - scale.y) > 0.05 * scale.x ? undefined : layer.lines.map((words) => layerLine(words, scale));
};

interface Extent {
    readonly start: number;
    readonly end: number;
}

// Between two pages in the checker's text: no detector reads across a form feed on a line of its own.
const PAGE_BREAK = "\n\f\n";

export interface DocumentWords {
    // What the checker reads: every page's reading text (image-mask.ts readingText), pages apart.
    readonly text: string;
    // The finds that each stand for a value once (image-mask.ts distinctFinds, page by page), offsets in `text`.
    readonly keep: <S extends Extent>(spans: readonly S[]) => S[];
    // The finds on one page, in offsets into that page's own reading text; one reaching past the page cut at its edge.
    readonly onPage: <S extends Extent>(spans: readonly S[], page: number) => S[];
}

export const documentWords = (pages: readonly PdfPage[]): DocumentWords => {
    const texts = pages.map((page) => readingText(page.lines));
    const starts: number[] = [];
    let at = 0;
    for (const text of texts) {
        starts.push(at);
        at += text.length + PAGE_BREAK.length;
    }
    const onPage = <S extends Extent>(spans: readonly S[], page: number): S[] => {
        const start = starts[page] ?? 0;
        const end = start + (texts[page]?.length ?? 0);
        return spans.flatMap((span) =>
            span.end <= start || span.start >= end
                ? []
                : [{ ...span, start: Math.max(span.start, start) - start, end: Math.min(span.end, end) - start }],
        );
    };
    return {
        text: texts.join(PAGE_BREAK),
        onPage,
        keep: (spans) =>
            pages.flatMap((page, index) =>
                distinctFinds(page.lines, onPage(spans, index)).map((span) => ({
                    ...span,
                    start: span.start + (starts[index] ?? 0),
                    end: span.end + (starts[index] ?? 0),
                })),
            ),
    };
};

// The drawn pages (JPEG, as the reader read them) with each page's regions painted over, bound into a PDF of pictures.
export const paintedPdf = async (
    drawn: readonly Buffer[],
    pages: readonly PdfPage[],
    regions: readonly (readonly MaskRegion[])[],
): Promise<Buffer | undefined> => {
    const painted: { jpeg: Buffer; width: number; height: number }[] = [];
    for (const [index, jpeg] of drawn.entries()) {
        const page = pages[index];
        const own = regions[index] ?? [];
        if (page === undefined) {
            return undefined;
        }
        const image = own.length === 0 ? { mediaType: "image/jpeg", data: jpeg.toString("base64") } : await paintRegions(jpeg, own);
        if (image?.mediaType !== "image/jpeg") {
            return undefined;
        }
        painted.push({ jpeg: Buffer.from(image.data, "base64"), width: page.width, height: page.height });
    }
    return painted.length === pages.length ? imagePdf(painted) : undefined;
};

// A PDF of one JPEG per page, each page the picture's size at PDF_DPI. Written out by hand: nothing in it but the
// pictures, no date and no id, so the same pages always make the same bytes and a provider's prompt cache keeps.
const imagePdf = (pages: readonly { readonly jpeg: Buffer; readonly width: number; readonly height: number }[]): Buffer => {
    const points = (pixels: number): string => String(Math.round(((pixels * 72) / PDF_DPI) * 100) / 100);
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
    let length = chunks[0]?.length ?? 0;
    const offsets: number[] = [];
    const object = (body: Buffer | string, stream?: Buffer): void => {
        offsets.push(length);
        const parts = [Buffer.from(`${String(offsets.length)} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")];
        if (stream !== undefined) {
            parts.push(Buffer.from("\nstream\n", "latin1"), stream, Buffer.from("\nendstream", "latin1"));
        }
        parts.push(Buffer.from("\nendobj\n", "latin1"));
        for (const part of parts) {
            chunks.push(part);
            length += part.length;
        }
    };
    // Objects 1 and 2 are the catalog and the page tree; each page then takes three: itself, its picture, its drawing.
    const pageObject = (index: number): number => 3 + index * 3;
    object("<< /Type /Catalog /Pages 2 0 R >>");
    object(`<< /Type /Pages /Kids [${pages.map((_, index) => `${String(pageObject(index))} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`);
    for (const [index, page] of pages.entries()) {
        const self = pageObject(index);
        const [width, height] = [points(page.width), points(page.height)];
        const drawing = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /P Do Q`, "latin1");
        object(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /P ${String(self + 1)} 0 R >> >> /Contents ${String(self + 2)} 0 R >>`,
        );
        object(
            `<< /Type /XObject /Subtype /Image /Width ${String(page.width)} /Height ${String(page.height)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${String(page.jpeg.length)} >>`,
            page.jpeg,
        );
        object(`<< /Length ${String(drawing.length)} >>`, drawing);
    }
    const xref = length;
    const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    chunks.push(
        Buffer.from(
            `xref\n0 ${String(offsets.length + 1)}\n0000000000 65535 f \n${table}trailer\n<< /Size ${String(offsets.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`,
            "latin1",
        ),
    );
    return Buffer.concat(chunks);
};
