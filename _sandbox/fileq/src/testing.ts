import { strToU8, zipSync } from "fflate";

/* Fixture BUILDERS, one per binary format the suites derive, shared so the deriver tests and the CLI tests
 * cannot drift on what "a docx" means here. Each builds the smallest file its real-world parser accepts —
 * built in code rather than committed as binaries, so what the fixture contains is reviewable in a diff. */

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
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p>`,
        ...paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`),
    ].join("");
    return zipSync({
        "[Content_Types].xml": strToU8(
            CONTENT_TYPES('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
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
<p:cSld><p:spTree>${lines.map((line) => `<p:sp><p:txBody><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld>
</p:sld>`;

/** A presentation with one slide per entry of `slides`, each slide one text line per entry. */
export const pptxBytes = (slides: readonly (readonly string[])[]): Uint8Array => {
    const files: Record<string, Uint8Array> = {
        "[Content_Types].xml": strToU8(
            CONTENT_TYPES('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'),
        ),
        "_rels/.rels": strToU8(RELS("ppt/presentation.xml")),
        "ppt/presentation.xml": strToU8('<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
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

/** A 1×1 PNG (no EXIF — dimensions are what image derivation reads off it). */
export const pngBytes = (): Uint8Array =>
    Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
