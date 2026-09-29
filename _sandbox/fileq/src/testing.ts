import { gzipSync, strToU8, zipSync } from "fflate";

// Fixture builders, one per binary format the suites derive, shared so deriver tests and CLI tests can't disagree on
// what "a docx" means.
// Each builds the smallest file its real-world parser accepts, in code rather than committed binaries, so the fixture's
// content is reviewable in a diff.

// Fixture text sits inside XML text nodes; a hostile fixture's payload must be text, not broken XML.
const xmlEscape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const CONTENT_TYPES = (overrides: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${overrides}
</Types>`;

const RELS = (target: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>
</Relationships>`;

/** A one-heading, N-paragraph Word document mammoth accepts. */
export const docxBytes = (heading: string, paragraphs: readonly string[]): Uint8Array => {
    const body = [
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(heading)}</w:t></w:r></w:p>`,
        ...paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`),
    ].join("");
    return zipSync({
        "[Content_Types].xml": strToU8(
            CONTENT_TYPES(
                '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
            ),
        ),
        "_rels/.rels": strToU8(RELS("word/document.xml")),
        "word/document.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        ),
    });
};

const slideXml = (lines: readonly string[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>${lines.map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(line)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld>
</p:sld>`;

/** A presentation with one slide per entry of `slides`, each slide one text line per entry. */
export const pptxBytes = (slides: readonly (readonly string[])[]): Uint8Array => {
    const files: Record<string, Uint8Array> = {
        "[Content_Types].xml": strToU8(
            CONTENT_TYPES(
                '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
            ),
        ),
        "_rels/.rels": strToU8(RELS("ppt/presentation.xml")),
        "ppt/presentation.xml": strToU8(
            '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
        ),
    };
    slides.forEach((lines, index) => {
        files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slideXml(lines));
    });
    return zipSync(files);
};

/**
 * Smallest well-formed one-page PDF with a text layer saying `text`; honest xref offsets keep it out of pdf.js's
 * damaged-file recovery path.
 */
export const pdfBytes = (text: string): Uint8Array => {
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
        `4 0 obj\n<< /Length ${text.length + 31} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream\nendobj\n`,
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    ];
    const header = "%PDF-1.4\n";
    const offsets: number[] = [];
    let position = header.length;
    for (const object of objects) {
        offsets.push(position);
        position += object.length;
    }
    const xref = [
        "xref",
        `0 ${objects.length + 1}`,
        "0000000000 65535 f ",
        ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
        "",
    ].join("\n");
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
    return strToU8(`${header}${objects.join("")}${xref}${trailer}`);
};

/** One second of 8kHz mono 8-bit silence in a well-formed RIFF/WAVE container. */
export const wavBytes = (): Uint8Array => {
    const sampleRate = 8000;
    const data = new Uint8Array(sampleRate).fill(128);
    const buffer = new ArrayBuffer(44 + data.length);
    const view = new DataView(buffer);
    const ascii = (offset: number, value: string): void => {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + data.length, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    ascii(36, "data");
    view.setUint32(40, data.length, true);
    const bytes = new Uint8Array(buffer);
    bytes.set(data, 44);
    return bytes;
};

// OpenDocument/EPUB need `mimetype` first in the archive and stored (level 0), per spec.
const storedMimetype = (mimetype: string): [Uint8Array, { level: 0 }] => [strToU8(mimetype), { level: 0 }];

/** A one-heading, N-paragraph OpenDocument text with a two-item list and a 1×2 table, in ODF's own vocabulary. */
export const odtBytes = (heading: string, paragraphs: readonly string[]): Uint8Array =>
    zipSync({
        mimetype: storedMimetype("application/vnd.oasis.opendocument.text"),
        "META-INF/manifest.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`,
        ),
        "meta.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>${xmlEscape(heading)}</dc:title></office:meta></office:document-meta>`,
        ),
        "content.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">
<office:automatic-styles><style:style style:name="P1" style:family="paragraph"/></office:automatic-styles>
<office:body><office:text>
<text:h text:style-name="Heading_20_1" text:outline-level="1">${xmlEscape(heading)}</text:h>
${paragraphs.map((text) => `<text:p text:style-name="P1">${xmlEscape(text)}</text:p>`).join("\n")}
<office:annotation><text:p>a reviewer's comment, not the document</text:p></office:annotation>
<text:list text:style-name="L1"><text:list-item><text:p>first item</text:p></text:list-item><text:list-item><text:p>second<text:s text:c="2"/>item</text:p></text:list-item></text:list>
<table:table table:name="T1"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>cell a</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>cell b</text:p></table:table-cell></table:table-row></table:table>
</office:text></office:body></office:document-content>`,
        ),
    });

const odfPackage = (mimetype: string, content: string): Uint8Array =>
    zipSync({
        mimetype: storedMimetype(mimetype),
        "META-INF/manifest.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`,
        ),
        "content.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0">
<office:body>${content}</office:body></office:document-content>`,
        ),
    });

/** An OpenDocument spreadsheet: one sheet per entry, each row padded out the way a real .ods pads its own. */
export const odsBytes = (sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[] }[]): Uint8Array =>
    odfPackage(
        "application/vnd.oasis.opendocument.spreadsheet",
        `<office:spreadsheet>${sheets
            .map(
                (sheet) =>
                    `<table:table table:name="${xmlEscape(sheet.name)}">${sheet.rows
                        .map(
                            (row) =>
                                `<table:table-row>${row
                                    .map((cell) => `<table:table-cell office:value-type="string"><text:p>${xmlEscape(cell)}</text:p></table:table-cell>`)
                                    .join("")}<table:table-cell table:number-columns-repeated="1013"/></table:table-row>`,
                        )
                        .join("")}<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table>`,
            )
            .join("")}</office:spreadsheet>`,
    );

/** An OpenDocument presentation: one page per entry, each with its lines and a speaker's note. */
export const odpBytes = (slides: readonly { readonly name: string; readonly lines: readonly string[]; readonly note?: string }[]): Uint8Array =>
    odfPackage(
        "application/vnd.oasis.opendocument.presentation",
        `<office:presentation>${slides
            .map(
                (slide) =>
                    `<draw:page draw:name="${xmlEscape(slide.name)}">` +
                    `<draw:frame><draw:text-box>${slide.lines.map((line) => `<text:p>${xmlEscape(line)}</text:p>`).join("")}</draw:text-box></draw:frame>${ 
                    slide.note === undefined
                        ? ""
                        : `<presentation:notes><draw:frame><draw:text-box><text:p>${xmlEscape(slide.note)}</text:p></draw:text-box></draw:frame></presentation:notes>` 
                    }</draw:page>`,
            )
            .join("")}</office:presentation>`,
    );

/** A Word-shaped RTF: a font table and an ignorable group to skip, a \\'hh escape, and one table row. */
export const rtfBytes = (paragraphs: readonly string[]): Uint8Array =>
    strToU8(
        `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}}{\\*\\generator Not text;}${ 
            paragraphs.map((text) => `\\pard ${text.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}")}\\par`).join("") 
            }\\pard\\trowd\\cellx1440\\cellx2880 left\\cell right\\cell\\row}`,
    );

/** An EPUB 3 with one XHTML chapter per entry, spine-ordered, plus a nav document that must not read as a chapter. */
export const epubBytes = (title: string, chapters: readonly { readonly title: string; readonly body: string }[]): Uint8Array => {
    const xhtml = (heading: string, body: string): string =>
        `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xmlEscape(heading)}</title></head><body><h1>${xmlEscape(heading)}</h1><p>${xmlEscape(body)}</p></body></html>`;
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
        mimetype: storedMimetype("application/epub+zip"),
        "META-INF/container.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        ),
        "OEBPS/content.opf": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title><dc:identifier id="id">urn:uuid:fixture</dc:identifier></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, index) => `<item id="c${index + 1}" href="text/chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest>
<spine><itemref idref="nav"/>${chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join("")}</spine></package>`,
        ),
        "OEBPS/nav.xhtml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((chapter, index) => `<li><a href="text/chapter${index + 1}.xhtml">${xmlEscape(chapter.title)}</a></li>`).join("")}</ol></nav></body></html>`,
        ),
    };
    chapters.forEach((chapter, index) => {
        files[`OEBPS/text/chapter${index + 1}.xhtml`] = strToU8(xhtml(chapter.title, chapter.body));
    });
    return zipSync(files);
};

/** A Jupyter notebook (nbformat 4) with a markdown title cell, a code cell with stream output, and one rich output. */
export const ipynbText = (title: string, code: string, outputLines: readonly string[]): string =>
    JSON.stringify({
        cells: [
            { cell_type: "markdown", metadata: {}, source: [`# ${title}\n`, "\n", "Some prose about the analysis.\n"] },
            {
                cell_type: "code",
                execution_count: 1,
                metadata: {},
                source: [code],
                outputs: [
                    { output_type: "stream", name: "stdout", text: outputLines.map((line) => `${line}\n`) },
                    { output_type: "display_data", metadata: {}, data: { "image/png": "iVBORw0KGgo=" } },
                ],
            },
        ],
        metadata: { kernelspec: { language: "python", name: "python3" }, language_info: { name: "python" } },
        nbformat: 4,
        nbformat_minor: 5,
    });

/** A zip holding one member per key, deflated the way any packing tool writes it. */
export const zipBytes = (files: Readonly<Record<string, string>>): Uint8Array =>
    zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));

const TAR_BLOCK = 512;

// One ustar header block. The checksum is summed with its own field read as spaces, which is the rule that makes a
// header verifiable at all.
const tarHeader = (path: string, size: number, type: string): Uint8Array => {
    const block = new Uint8Array(TAR_BLOCK);
    const put = (offset: number, value: string): void => block.set(strToU8(value), offset);
    put(0, path.slice(0, 100));
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${size.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    block.fill(0x20, 148, 156);
    put(156, type);
    put(257, "ustar\0");
    put(263, "00");
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    return block;
};

const padded = (bytes: Uint8Array): Uint8Array => {
    const block = new Uint8Array(Math.ceil(bytes.length / TAR_BLOCK) * TAR_BLOCK);
    block.set(bytes);
    return block;
};

/**
 * A tar holding one member per key, in the layout GNU tar writes: a header per member, data padded to the block,
 * two zero blocks at the end. A path past the 100-byte name field gets an 'L' block in front of it, as GNU tar does.
 */
export const tarBytes = (files: Readonly<Record<string, string>>): Uint8Array => {
    const parts: Uint8Array[] = [];
    for (const [path, text] of Object.entries(files)) {
        const data = strToU8(text);
        if (path.length > 100) {
            parts.push(tarHeader("././@LongLink", path.length + 1, "L"), padded(strToU8(`${path}\0`)));
        }
        parts.push(tarHeader(path, data.length, path.endsWith("/") ? "5" : "0"), padded(data));
    }
    parts.push(new Uint8Array(TAR_BLOCK * 2));
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const tar = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        tar.set(part, offset);
        offset += part.length;
    }
    return tar;
};

/** A gzip member carrying the original name in its header, the way `gzip <file>` writes one. */
export const gzipBytes = (name: string, content: Uint8Array | string): Uint8Array =>
    gzipSync(typeof content === "string" ? strToU8(content) : content, { filename: name });

/** A 1×1 PNG (no EXIF — dimensions are what image derivation reads off it). */
export const pngBytes = (): Uint8Array =>
    Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

/* ---- documents to check: small OOXML and PDF files with one known defect each, built from their parts ---------- */

const EMU = 914_400;
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface FixtureRel {
    readonly type: string;
    readonly target: string;
    readonly external?: boolean;
}

const relsXml = (rels: Readonly<Record<string, FixtureRel>>): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(rels)
        .map(([id, rel]) => `<Relationship Id="${id}" Type="${REL_TYPE}/${rel.type}" Target="${xmlEscape(rel.target)}"${rel.external === true ? ' TargetMode="External"' : ""}/>`)
        .join("")}</Relationships>`;

/** Where a shape sits, in inches from the slide's top left. */
export interface Frame {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

const xfrm = (frame: Frame, tag = "a:xfrm"): string =>
    `<${tag}><a:off x="${Math.round(frame.x * EMU)}" y="${Math.round(frame.y * EMU)}"/><a:ext cx="${Math.round(frame.w * EMU)}" cy="${Math.round(frame.h * EMU)}"/></${tag}>`;

export interface TextBoxOptions {
    /** Point size of every run; unset inherits (18 pt for a plain text box). */
    readonly size?: number;
    /** A placeholder of this type (and idx); a placeholder with no frame inherits its layout's. */
    readonly ph?: { readonly type?: string; readonly idx?: number };
    readonly autofit?: "shrink" | "grow";
}

let drawingId = 10;

/** A text shape: one paragraph per line; `frame` undefined leaves the geometry to the layout (placeholders only). */
export const textBox = (name: string, frame: Frame | undefined, lines: readonly string[], options: TextBoxOptions = {}): string => {
    drawingId += 1;
    const ph = options.ph === undefined ? "" : `<p:ph${options.ph.type === undefined ? "" : ` type="${options.ph.type}"`}${options.ph.idx === undefined ? "" : ` idx="${options.ph.idx}"`}/>`;
    const fit = options.autofit === "shrink" ? "<a:normAutofit/>" : options.autofit === "grow" ? "<a:spAutoFit/>" : "";
    const size = options.size === undefined ? "" : ` sz="${options.size * 100}"`;
    const paragraphs = lines.length === 0 ? "<a:p/>" : lines.map((line) => `<a:p><a:r><a:rPr lang="en-US"${size}/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`).join("");
    return `<p:sp><p:nvSpPr><p:cNvPr id="${drawingId}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${frame === undefined ? "" : xfrm(frame)}</p:spPr><p:txBody><a:bodyPr wrap="square">${fit}</a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
};

/** A picture drawing its image from relationship `rId`, optionally cropped (fractions of 100000 per side). */
export const pictureFrame = (name: string, frame: Frame, rId: string, crop?: { readonly l?: number; readonly r?: number; readonly t?: number; readonly b?: number }): string => {
    drawingId += 1;
    const src = crop === undefined ? "" : `<a:srcRect l="${crop.l ?? 0}" r="${crop.r ?? 0}" t="${crop.t ?? 0}" b="${crop.b ?? 0}"/>`;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${drawingId}" name="${xmlEscape(name)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
};

/** A table frame with one row per entry, each row `height` inches tall and its cells in `size`-point text. */
export const tableFrame = (name: string, frame: Frame, rows: readonly (readonly string[])[], height: number, size = 18): string => {
    drawingId += 1;
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const columnWidth = Math.round((frame.w * EMU) / columns);
    const cells = (row: readonly string[]): string =>
        row.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size * 100}"/><a:t>${xmlEscape(cell)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`).join("");
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${drawingId}" name="${xmlEscape(name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(frame, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid>${Array.from({ length: columns }, () => `<a:gridCol w="${columnWidth}"/>`).join("")}</a:tblGrid>${rows.map((row) => `<a:tr h="${Math.round(height * EMU)}">${cells(row)}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
};

export interface DeckSlide {
    /** The spTree's drawings, as XML (textBox, pictureFrame, tableFrame, or by hand). */
    readonly drawings: readonly string[];
    /** Relationships beyond the layout, which every slide gets as rId1. */
    readonly rels?: Readonly<Record<string, FixtureRel>>;
    readonly hidden?: boolean;
    /** The part's file number, when a test needs parts numbered out of deck order. */
    readonly partNumber?: number;
}

export interface DeckOptions {
    readonly slides: readonly DeckSlide[];
    /** Media parts by name under ppt/media/. */
    readonly media?: Readonly<Record<string, Uint8Array>>;
    /** Slide size in inches; 13.333 × 7.5 (16:9) by default. */
    readonly width?: number;
    readonly height?: number;
    /** Leave png out of [Content_Types].xml, the damage a hand-zipped deck carries. */
    readonly untypedMedia?: boolean;
}

// A master with a title and a body placeholder and the text styles they inherit (44 pt titles, 28 pt body), and one
// "Title and Content" layout whose placeholders carry no frame of their own, so a slide's geometry comes from the master.
const MASTER = `<?xml version="1.0" encoding="UTF-8"?>
<p:sldMaster ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 0.92, y: 0.4, w: 11.5, h: 1.45 })}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 0.92, y: 2, w: 11.5, h: 4.75 })}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`;

const LAYOUT = `<?xml version="1.0" encoding="UTF-8"?>
<p:sldLayout ${NS_P} type="obj"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit Master title style</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>`;

/** A PowerPoint deck with a real slide list, master and layout, one slide part per entry of `slides`. */
export const deckBytes = (options: DeckOptions): Uint8Array => {
    const width = Math.round((options.width ?? 13.333) * EMU);
    const height = Math.round((options.height ?? 7.5) * EMU);
    const numbers = options.slides.map((slide, index) => slide.partNumber ?? index + 1);
    const types = [
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        ...numbers.map((number) => `<Override PartName="/ppt/slides/slide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
        options.untypedMedia === true ? "" : '<Default Extension="png" ContentType="image/png"/>',
    ].join("");
    const files = new Map<string, Uint8Array>([
        ["[Content_Types].xml", strToU8(CONTENT_TYPES(types))],
        ["_rels/.rels", strToU8(RELS("ppt/presentation.xml"))],
        ["ppt/presentation.xml", strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation ${NS_P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${numbers.map((number, index) => `<p:sldId id="${256 + index}" r:id="rId${number + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
        )],
        ["ppt/_rels/presentation.xml.rels", strToU8(
            relsXml({
                rId1: { type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
                ...Object.fromEntries(numbers.map((number) => [`rId${number + 1}`, { type: "slide", target: `slides/slide${number}.xml` }])),
            }),
        )],
        ["ppt/slideMasters/slideMaster1.xml", strToU8(MASTER)],
        ["ppt/slideMasters/_rels/slideMaster1.xml.rels", strToU8(relsXml({ rId1: { type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" } }))],
        ["ppt/slideLayouts/slideLayout1.xml", strToU8(LAYOUT)],
        ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", strToU8(relsXml({ rId1: { type: "slideMaster", target: "../slideMasters/slideMaster1.xml" } }))],
    ]);
    options.slides.forEach((slide, index) => {
        const number = numbers[index] ?? index + 1;
        files.set(`ppt/slides/slide${number}.xml`, strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<p:sld ${NS_P}${slide.hidden === true ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${slide.drawings.join("")}</p:spTree></p:cSld></p:sld>`,
            ),
        );
        files.set(`ppt/slides/_rels/slide${number}.xml.rels`, strToU8(relsXml({ rId1: { type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }, ...slide.rels })));
    });
    for (const [name, bytes] of Object.entries(options.media ?? {})) {
        files.set(`ppt/media/${name}`, bytes);
    }
    return zipSync(Object.fromEntries(files));
};

/** A PNG header claiming `width` × `height` pixels: all an aspect-ratio check reads of it. */
export const pngOfSize = (width: number, height: number): Uint8Array => {
    const png = pngBytes().slice();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return png;
};

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** A paragraph: plain, or in a style by id. */
export const para = (text: string, style?: string): string =>
    `<w:p>${style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${text === "" ? "" : `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`}</w:p>`;

/** An inline picture `width` inches wide drawing relationship `rId`, in a paragraph of its own. */
export const inlinePicture = (rId: string, width: number, height: number): string =>
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${Math.round(width * EMU)}" cy="${Math.round(height * EMU)}"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${rId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

/** A complex field: begin, instruction, separate, the saved result (none when undefined), end. */
export const field = (instruction: string, result: string | undefined): string =>
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${xmlEscape(instruction)} </w:instrText></w:r>${result === undefined ? "" : `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${xmlEscape(result)}</w:t></w:r>`}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

export interface WordOptions {
    /** The body's paragraphs and tables, as XML (para, field, inlinePicture, or by hand). */
    readonly body: readonly string[];
    readonly rels?: Readonly<Record<string, FixtureRel>>;
    readonly media?: Readonly<Record<string, Uint8Array>>;
    /** Comment texts, written as word/comments.xml. */
    readonly comments?: readonly string[];
}

// Heading styles under ids that are not their names, the way a localised Word template writes them: the check must
// read the style's name, not guess from its id.
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="berschrift2"/></w:style></w:styles>`;

/** A Word document with styles (headings under localised ids), a letter-size section, and optional comments and media. */
export const wordBytes = (options: WordOptions): Uint8Array => {
    const commentRels = options.comments === undefined ? {} : { rIdComments: { type: "comments", target: "comments.xml" } };
    const files = new Map<string, Uint8Array>([
        ["[Content_Types].xml", strToU8(
            CONTENT_TYPES(
                [
                    '<Default Extension="png" ContentType="image/png"/>',
                    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
                    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
                    options.comments === undefined ? "" : '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
                ].join(""),
            ),
        )],
        ["_rels/.rels", strToU8(RELS("word/document.xml"))],
        ["word/styles.xml", strToU8(STYLES)],
        ["word/document.xml", strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${NS_W}><w:body>${options.body.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/></w:sectPr></w:body></w:document>`,
        )],
    ]);
    if (options.comments !== undefined) {
        files.set("word/comments.xml", strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${options.comments.map((text, index) => `<w:comment w:id="${index}" w:author="Reviewer"><w:p><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p></w:comment>`).join("")}</w:comments>`,
            ),
        );
    }
    files.set("word/_rels/document.xml.rels", strToU8(relsXml({ rIdStyles: { type: "styles", target: "styles.xml" }, ...options.rels, ...commentRels })));
    for (const [name, bytes] of Object.entries(options.media ?? {})) {
        files.set(`word/media/${name}`, bytes);
    }
    return zipSync(Object.fromEntries(files));
};

export interface SheetFixture {
    readonly name: string;
    /** The sheetData's rows, as XML: `<row r="1"><c r="A1"><v>1</v></c></row>`. */
    readonly rows: string;
}

/** An Excel workbook, one worksheet per entry, with optional defined names and calculation settings. */
export const workbookBytes = (sheets: readonly SheetFixture[], options: { readonly definedNames?: string; readonly calcPr?: string } = {}): Uint8Array => {
    const files = new Map<string, Uint8Array>([
        ["[Content_Types].xml", strToU8(
            CONTENT_TYPES(
                [
                    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
                    ...sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
                ].join(""),
            ),
        )],
        ["_rels/.rels", strToU8(RELS("xl/workbook.xml"))],
        ["xl/workbook.xml", strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>${options.definedNames === undefined ? "" : `<definedNames>${options.definedNames}</definedNames>`}${options.calcPr ?? ""}</workbook>`,
        )],
        ["xl/_rels/workbook.xml.rels", strToU8(relsXml(Object.fromEntries(sheets.map((_, index) => [`rId${index + 1}`, { type: "worksheet", target: `worksheets/sheet${index + 1}.xml` }]))))],
    ]);
    sheets.forEach((sheet, index) => {
        files.set(`xl/worksheets/sheet${index + 1}.xml`, strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows}</sheetData></worksheet>`,
            ),
        );
    });
    return zipSync(Object.fromEntries(files));
};

export interface PdfPageFixture {
    /** The page's content stream, e.g. `BT /F1 12 Tf 72 720 Td (Hello) Tj ET`; empty draws nothing. */
    readonly content: string;
    /** The BaseFont /F1 names; Helvetica (one of the fourteen every reader has) by default. */
    readonly font?: string;
    /** Extra page dictionary entries, e.g. `/Annots [...]`. */
    readonly extra?: string;
    /** Width and height in points; US Letter by default. */
    readonly size?: readonly [number, number];
}

/** A PDF with one page per entry, honest xref offsets, and no font embedded (a font the reader lacks is substituted). */
export const pdfPagesBytes = (pages: readonly PdfPageFixture[]): Uint8Array => {
    const objects: string[] = ["", ""];
    const add = (body: string): number => objects.push(body);
    const kids = pages.map((page) => {
        const font = add(`<< /Type /Font /Subtype /${page.font === undefined ? "Type1" : "TrueType"} /BaseFont /${page.font ?? "Helvetica"} >>`);
        const content = add(`<< /Length ${page.content.length} >>\nstream\n${page.content}\nendstream`);
        const [width, height] = page.size ?? [612, 792];
        return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> ${page.extra ?? ""} >>`);
    });
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n";
    const offsets = objects.map((body, index) => {
        const offset = out.length;
        out += `${index + 1} 0 obj\n${body}\nendobj\n`;
        return offset;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return strToU8(out);
};
