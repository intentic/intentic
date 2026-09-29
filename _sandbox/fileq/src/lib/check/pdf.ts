// Structural checks over a PDF: blank pages, text set in fonts the file does not carry, internal links to nowhere, a
// page size that changes partway, and a document with no text layer at all. Read through pdf.js (unpdf), which the
// deriver already loads: a page's operator list says whether anything is drawn on it and in which fonts.
//
// The blank-page and unembedded-font rules are adapted from SurfSense's PDF artifact verification
// (surfsense_backend/app/artifacts/verification/formats/pdf.py, Copyright (c) SurfSense, Apache-2.0,
// https://github.com/MODSetter/SurfSense; see this package's NOTICE). Changed here: a page is blank only when nothing
// at all is drawn on it (a cover image with no text is not), and the fourteen standard PDF fonts, which every reader
// carries, are never reported as missing.
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { error, plural, warning, type CheckReport, type Finding } from "./finding.js";

// Past this, the rest of a long PDF is left unchecked and the notes say so.
const MAX_PAGES = 500;
const POINTS_PER_INCH = 72;

const STANDARD_FONTS = new Set([
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
    "Times-Roman",
    "Times-Bold",
    "Times-Italic",
    "Times-BoldItalic",
    "Courier",
    "Courier-Bold",
    "Courier-Oblique",
    "Courier-BoldOblique",
    "Symbol",
    "ZapfDingbats",
]);

type Operators = Awaited<ReturnType<typeof getResolvedPDFJS>>["OPS"];

// The operator codes that draw: text, and paths and images. pdf.js is resolved when a PDF is checked, never at load:
// every fileq run imports this module, and pdf.js is the largest thing it could pull in.
interface Painters {
    readonly setFont: number;
    readonly constructPath: number;
    readonly text: ReadonlySet<number>;
    readonly paint: ReadonlySet<number>;
}

const paintersOf = (OPS: Operators): Painters => ({
    setFont: OPS.setFont,
    constructPath: OPS.constructPath,
    text: new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]),
    paint: new Set([
        OPS.stroke,
        OPS.closeStroke,
        OPS.fill,
        OPS.eoFill,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke,
        OPS.shadingFill,
        OPS.rawFillPath,
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintInlineImageXObjectGroup,
        OPS.paintImageXObjectRepeat,
        OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintSolidColorImageMask,
    ]),
});

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

interface PageScan {
    readonly characters: number;
    readonly painted: boolean;
    /** Base names of the fonts that drew visible text and are not in the file. */
    readonly missingFonts: readonly string[];
}

// What this module reads of pdf.js's untyped operator arguments, fonts and annotations, declared once at the boundary.
// A glyph run is glyph objects with numbers (spacing adjustments) between them.
interface Glyph {
    readonly unicode?: string;
}
type Operand = string | number | null | readonly (Glyph | number)[];
interface PdfFont {
    readonly name?: string;
    /** pdf.js found no font program in the file and fell back to a system font. */
    readonly missingFile?: boolean;
}
interface PdfAnnotation {
    readonly subtype?: string;
    /** A named destination, an explicit one (an array), or none. */
    readonly dest?: string | readonly Operand[] | null;
}

const isGlyph = (item: Glyph | number): item is Glyph => typeof item !== "number";

const visibleCharacters = (run: readonly (Glyph | number)[]): number => run.filter((item) => isGlyph(item) && /\S/.test(item.unicode ?? "")).length;

interface UsedFont {
    /** The base font name, a subset's six-letter prefix removed. */
    readonly name: string;
    readonly missing: boolean;
}

const fontOf = (page: PdfPage, id: string | undefined): UsedFont | undefined => {
    if (id === undefined) {
        return undefined;
    }
    let font: PdfFont | undefined;
    try {
        font = page.commonObjs.get(id);
    } catch {
        // allow(silent-catch): pdf.js throws for a font it never resolved, and a font never loaded drew nothing.
        return undefined;
    }
    return { name: (font?.name ?? "").replace(/^[A-Z]{6}\+/, ""), missing: font?.missingFile === true };
};

const scanPage = async (page: PdfPage, ops: Painters): Promise<PageScan> => {
    const list = await page.getOperatorList();
    const operands: readonly (readonly Operand[] | null)[] = list.argsArray;
    let characters = 0;
    let painted = false;
    let currentFont: string | undefined;
    const missing = new Set<string>();
    list.fnArray.forEach((op, index) => {
        const first = operands[index]?.[0];
        if (op === ops.setFont) {
            currentFont = first === undefined || first === null ? undefined : String(first);
        } else if (ops.text.has(op)) {
            const count = Array.isArray(first) ? visibleCharacters(first) : 0;
            characters += count;
            const font = count > 0 ? fontOf(page, currentFont) : undefined;
            if (font?.missing === true && font.name !== "" && !STANDARD_FONTS.has(font.name)) {
                missing.add(font.name);
            }
        } else if (ops.paint.has(op) || (op === ops.constructPath && ops.paint.has(Number(first)))) {
            painted = true;
        }
    });
    return { characters, painted: painted || characters > 0, missingFonts: [...missing] };
};

// A link whose named destination the file does not define goes nowhere when clicked.
const linkFindings = async (pdf: PdfDocument, page: PdfPage, number: number): Promise<Finding[]> => {
    const annotations: readonly PdfAnnotation[] = await page.getAnnotations();
    const findings: Finding[] = [];
    for (const annotation of annotations) {
        const dest = annotation.dest;
        if (annotation.subtype !== "Link" || dest === undefined || dest === null || Array.isArray(dest)) {
            continue;
        }
        const named = String(dest);
        // allow(silent-catch): pdf.js throws where the file's destination tree is damaged, and then the link goes nowhere too.
        const target = await pdf.getDestination(named).catch(() => null);
        if (target === null) {
            findings.push(error("broken-link", `page ${number}`, `a link goes to "${named}", a destination the file does not define, so clicking it does nothing`));
        }
    }
    return findings;
};

const sizeLabel = (width: number, height: number): string =>
    `${Number((width / POINTS_PER_INCH).toFixed(2))} × ${Number((height / POINTS_PER_INCH).toFixed(2))} in`;

const pageList = (numbers: readonly number[]): string => (numbers.length > 6 ? `${numbers.slice(0, 6).join(", ")}, …` : numbers.join(", "));

const openPdf = async (bytes: Uint8Array): Promise<PdfDocument | CheckReport> => {
    try {
        // Errors only: pdf.js otherwise narrates its recovery of a damaged file on the console, into the report.
        return await getDocumentProxy(bytes, { verbosity: 0 });
    } catch (cause) {
        const reason = cause instanceof Error && cause.name === "PasswordException" ? "it is password-protected, so nothing past the password can be checked" : `it is not a readable PDF (${cause instanceof Error ? cause.message : String(cause)})`;
        return { format: "pdf", findings: [error("unreadable", "", reason)], notes: [] };
    }
};

export const checkPdf = async (bytes: Uint8Array): Promise<CheckReport> => {
    const pdf = await openPdf(bytes);
    if ("findings" in pdf) {
        return pdf;
    }
    const ops = paintersOf((await getResolvedPDFJS()).OPS);
    const findings: Finding[] = [];
    const notes: string[] = [];
    const total = pdf.numPages;
    if (total > MAX_PAGES) {
        notes.push(`checked the first ${MAX_PAGES} of ${total} pages`);
    }
    const sizes = new Map<string, number[]>();
    const unembedded = new Map<string, number[]>();
    let characters = 0;
    for (let number = 1; number <= Math.min(total, MAX_PAGES); number += 1) {
        const page = await pdf.getPage(number);
        const scan = await scanPage(page, ops);
        characters += scan.characters;
        if (!scan.painted) {
            findings.push(error("blank-page", `page ${number}`, "the page is blank: nothing is drawn on it"));
        }
        for (const font of scan.missingFonts) {
            unembedded.set(font, [...(unembedded.get(font) ?? []), number]);
        }
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
        const turned = page.rotate % 180 !== 0;
        const label = turned ? sizeLabel(y1 - y0, x1 - x0) : sizeLabel(x1 - x0, y1 - y0);
        sizes.set(label, [...(sizes.get(label) ?? []), number]);
        findings.push(...(await linkFindings(pdf, page, number)));
    }
    for (const [font, pages] of unembedded) {
        findings.push(
            warning("font-not-embedded", `page ${pageList(pages)}`, `text is set in ${font}, which the file does not carry: a reader without that font substitutes another, and lines can break differently; embed it`),
        );
    }
    if (sizes.size > 1) {
        const [common] = [...sizes.entries()].toSorted((a, b) => b[1].length - a[1].length);
        const odd = [...sizes.entries()].filter(([label]) => label !== common?.[0]);
        for (const [label, pages] of odd) {
            findings.push(warning("page-size", `page ${pageList(pages)}`, `${plural(pages.length, "page is", "pages are")} ${label}, the rest ${common?.[0] ?? "another size"}`));
        }
    }
    if (characters === 0 && total > 0) {
        findings.push(warning("no-text-layer", "", "no page has a text layer, so its words cannot be searched, copied or read aloud"));
    }
    return { format: "pdf", extent: plural(total, "page"), findings, notes };
};
