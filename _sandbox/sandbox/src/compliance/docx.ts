import { crc32, deflateRawSync } from "node:zlib";

// A Word document from the Markdown the compliance documents are written in. Only the Markdown those documents use:
// headings, paragraphs, bullet lists, pipe tables, **bold** and the blanks an office fills in. Hand-built rather than a
// library: a .docx is a zip of a few XML parts, and node:zlib already deflates and checksums, so a dependency would add
// megabytes to the daemon for one download button.

const xmlEscape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// **bold** runs; everything else is plain. A blank the office fills in is written `**[✎ …]**` (compliance-text.ts), and
// is highlighted too: in print, a highlighted run is what makes a blank impossible to miss.
const runs = (text: string): string =>
    text
        .split(/(\*\*[^*]+\*\*)/u)
        .filter((part) => part !== "")
        .map((part) => {
            if (part.startsWith("**") && part.endsWith("**")) {
                const inner = part.slice(2, -2);
                const highlight = inner.startsWith("[✎") ? `<w:highlight w:val="yellow"/>` : "";
                return `<w:r><w:rPr><w:b/>${highlight}</w:rPr><w:t xml:space="preserve">${xmlEscape(inner)}</w:t></w:r>`;
            }
            return `<w:r><w:t xml:space="preserve">${xmlEscape(part.replaceAll("`", ""))}</w:t></w:r>`;
        })
        .join("");

const paragraph = (text: string, style?: string): string =>
    `<w:p>${style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${runs(text)}</w:p>`;

const cells = (line: string): string[] =>
    line
        .trim()
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((cell) => cell.trim());

const table = (lines: readonly string[]): string => {
    const [head, , ...body] = lines;
    const row = (values: readonly string[], header: boolean): string =>
        `<w:tr>${values
            .map(
                (value) =>
                    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(header ? `**${value}**` : value)}</w:tc>`,
            )
            .join("")}</w:tr>`;
    const border = `w:val="single" w:sz="4" w:space="0" w:color="999999"`;
    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top ${border}/><w:left ${border}/><w:bottom ${border}/><w:right ${border}/><w:insideH ${border}/><w:insideV ${border}/></w:tblBorders></w:tblPr>${row(cells(head ?? ""), true)}${body
        .map((line) => row(cells(line), false))
        .join("")}</w:tbl>${paragraph("")}`;
};

// Block by block: a run of `|` lines is a table, `#` a heading, `- ` a bullet, anything else a paragraph.
export const markdownToDocumentXml = (markdown: string): string => {
    const lines = markdown.split("\n");
    const body: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (line.trim().startsWith("|")) {
            const block: string[] = [];
            while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
                block.push(lines[index] ?? "");
                index++;
            }
            index--;
            body.push(table(block));
            continue;
        }
        const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
        if (heading !== null) {
            body.push(paragraph(heading[2] ?? "", `Heading${(heading[1] ?? "#").length}`));
        } else if (/^\s*[-*]\s+/u.test(line)) {
            body.push(paragraph(`• ${line.replace(/^\s*[-*]\s+/u, "")}`, "ListBullet"));
        } else if (line.startsWith("> ")) {
            body.push(paragraph(line.slice(2), "Quote"));
        } else if (line.trim() !== "" && line.trim() !== "---") {
            body.push(paragraph(line));
        }
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="pl-PL"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/><w:ind w:left="360" w:hanging="220"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// A zip of deflated entries: local headers, then the central directory, then its end record (APPNOTE 4.3). No zip64,
// no data descriptors: a document is a few kilobytes.
export const zip = (files: Readonly<Record<string, string>>): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text, "utf8");
        const packed = deflateRawSync(data);
        const nameBytes = Buffer.from(name, "utf8");
        const checksum = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // names are UTF-8
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt32LE(0, 10); // time and date: none, so the same settings give the same bytes
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, packed);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + packed.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

export const markdownToDocx = (markdown: string): Buffer =>
    zip({
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": PACKAGE_RELS,
        "word/document.xml": markdownToDocumentXml(markdown),
        "word/_rels/document.xml.rels": DOCUMENT_RELS,
        "word/styles.xml": STYLES,
    });
