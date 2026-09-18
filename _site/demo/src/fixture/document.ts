import { strToU8, zipSync } from "fflate";

// The one file in the demo workspace served as real bytes rather than as text: a Word document, so the desk's quick
// look and the docx viewer have something true to draw. Built in code, not committed as a binary, so what it says is
// reviewable in a diff — the same rule fileq's own fixtures follow.

/** Where it sits in the tree: the drop folder, beside the archive someone else dropped. */
export const HANDOVER_PATH = `drop/handover.docx`;

/** The same document as a changed file of the web repo, for the Changes panel's diff of a Word document. */
export const HANDOVER_CHANGE = { repo: `web`, path: `docs/handover.docx` } as const;
export const HANDOVER_CHANGE_PATH = `${HANDOVER_CHANGE.repo}/${HANDOVER_CHANGE.path}`;

const xmlEscape = (text: string): string => text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`);

const HEADING = `Checkout handover`;
const PARAGRAPHS = [
    `Stripe is live in test mode. The publishable key is in the web app's environment, the secret in the API's; neither is in the repository.`,
    `Card, Apple Pay and Google Pay are on. Link is deliberately off until the fraud rules are written.`,
    `Open questions for Tuesday: whether a failed 3-D Secure challenge should keep the basket, and who owns the refund flow after launch.`,
    `The signup spec covers the happy path only. Everything under a declined card is still manual testing.`,
];

// What the document said before the handover was rewritten: one paragraph reworded, one dropped since, one added
// since. Same builder, so the two versions differ only in what they say.
const PARAGRAPHS_BEFORE = [
    PARAGRAPHS[0]!,
    `Card and Apple Pay are on. Link is on by default until the fraud rules are written.`,
    PARAGRAPHS[2]!,
    `Refunds are manual until the API supports them; ask Priya before promising one.`,
];

const paragraph = (text: string, style?: string): string =>
    `<w:p>${style === undefined ? `` : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

// A4 in twentieths of a point, with 1-inch margins: without a sectPr the renderer picks its own page, and the card
// would show a shape no word processor would have made.
const SECTION = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

const documentXml = (paragraphs: readonly string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(HEADING, `Heading1`)}${paragraphs
    .map((text) => paragraph(text))
    .join(``)}${SECTION}</w:body></w:document>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Copied into a plain ArrayBuffer, which is the only backing a Response body takes.
const build = (paragraphs: readonly string[]): Uint8Array<ArrayBuffer> =>
    new Uint8Array(
        zipSync({
            "[Content_Types].xml": strToU8(CONTENT_TYPES),
            "_rels/.rels": strToU8(PACKAGE_RELS),
            "word/document.xml": strToU8(documentXml(paragraphs)),
            "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
            "word/styles.xml": strToU8(STYLES),
        }),
    );

/** The document as the bytes a viewer parses; `/workspace/raw` hands these over unchanged. */
export const HANDOVER_DOCX: Uint8Array<ArrayBuffer> = build(PARAGRAPHS);
/** The version before the rewrite, the before side of its diff. */
export const HANDOVER_DOCX_BEFORE: Uint8Array<ArrayBuffer> = build(PARAGRAPHS_BEFORE);

// The text a daemon would render from each version (fileq's docx reading), for the diff's Text reading.
const markdown = (paragraphs: readonly string[]): string => [`# ${HEADING}`, ...paragraphs].join(`

`);
export const HANDOVER_TEXT = markdown(PARAGRAPHS);
export const HANDOVER_TEXT_BEFORE = markdown(PARAGRAPHS_BEFORE);
