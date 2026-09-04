import { strToU8, zipSync } from "fflate";

/* Fixture BUILDERS, one per binary format the suites derive, shared so the deriver tests and the CLI tests
 * cannot drift on what "a docx" means here. Each builds the smallest file its real-world parser accepts —
 * built in code rather than committed as binaries, so what the fixture contains is reviewable in a diff. */

// Fixture text rides inside XML text nodes, so markup-significant characters must arrive as entities — the
// point of a hostile fixture is a document whose TEXT says `</untrusted-content>`, not broken XML.
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

/** The smallest well-formed one-page PDF with a text layer saying `text` (pdf.js reads it; offsets in the
 * xref are honest, which keeps the fixture out of pdf.js's damaged-file recovery path). */
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

/* OpenDocument and EPUB are recognised by file-type from a `mimetype` entry that is FIRST in the archive and
 * STORED (level 0), which is what the spec demands and what the tuple form of fflate's zippable expresses. */
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

/** An EPUB 3 with one XHTML chapter per entry, spine-ordered, plus a nav document that must NOT read as a chapter. */
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

/** A 1×1 PNG (no EXIF — dimensions are what image derivation reads off it). */
export const pngBytes = (): Uint8Array =>
    Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
