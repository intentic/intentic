import { strToU8, zipSync } from "fflate";

/* Fixture builders: the smallest OpenDocument package each reader accepts, written in code rather than committed as
   binaries, so what a fixture contains is readable in a diff. */

const NAMESPACES = [
    `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"`,
    `xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"`,
    `xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"`,
    `xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"`,
    `xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"`,
    `xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"`,
    `xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"`,
    `xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"`,
    `xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    `xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"`,
].join(` `);

export const contentXml = (body: string, automaticStyles = ``): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NAMESPACES}>
<office:automatic-styles>${automaticStyles}</office:automatic-styles>
<office:body>${body}</office:body>
</office:document-content>`;

export const stylesXml = (styles = ``, master = ``): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NAMESPACES}>
<office:styles>${styles}</office:styles>
<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-left="2cm" fo:margin-right="2cm" fo:margin-top="2cm" fo:margin-bottom="2cm"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1" ${master}/></office:master-styles>
</office:document-styles>`;

const metaXml = (title: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NAMESPACES}><office:meta><dc:title>${title}</dc:title></office:meta></office:document-meta>`;

const MANIFEST = (mimetype: string, extra: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>${extra}
</manifest:manifest>`;

export interface OdfFixture {
    readonly mimetype: string;
    readonly content: string;
    readonly styles?: string;
    readonly title?: string;
    /** Extra package entries, e.g. a picture at `Pictures/one.png`, with its media type declared. */
    readonly files?: Readonly<Record<string, { readonly bytes: Uint8Array; readonly type: string }>>;
}

/** An OpenDocument package. `mimetype` is stored first and uncompressed, as the format requires. */
export const odfBytes = (fixture: OdfFixture): Uint8Array => {
    const extra = Object.entries(fixture.files ?? {})
        .map(([path, file]) => `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${file.type}"/>`)
        .join(``);
    const files: Record<string, [Uint8Array, { level: 0 }] | Uint8Array> = {
        mimetype: [strToU8(fixture.mimetype), { level: 0 }],
        "content.xml": strToU8(fixture.content),
        "styles.xml": strToU8(fixture.styles ?? stylesXml()),
        "meta.xml": strToU8(metaXml(fixture.title ?? ``)),
        "META-INF/manifest.xml": strToU8(MANIFEST(fixture.mimetype, extra)),
    };
    for (const [path, file] of Object.entries(fixture.files ?? {})) {
        files[path] = file.bytes;
    }
    return zipSync(files);
};

export const TEXT_MIME = `application/vnd.oasis.opendocument.text`;
export const SHEET_MIME = `application/vnd.oasis.opendocument.spreadsheet`;
export const SLIDES_MIME = `application/vnd.oasis.opendocument.presentation`;

/** The smallest real PNG: one transparent pixel, as base64 so the bytes stay readable in a diff. */
export const PNG_PIXEL = Uint8Array.from(
    atob(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==`),
    (char) => char.codePointAt(0) ?? 0,
);
