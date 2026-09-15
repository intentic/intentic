import { unzipSync } from "fflate";
import { descendants, descendant, parseXml, textOf, type XmlElement } from "./xml";

/* An OpenDocument file is a zip of XML parts plus its pictures. This opens one and hands out the parts; the viewers
   above it never touch bytes. */

export type OdfKind = "text" | "spreadsheet" | "presentation" | "drawing" | "unknown";

const KINDS: Readonly<Record<string, OdfKind>> = {
    "application/vnd.oasis.opendocument.text": `text`,
    "application/vnd.oasis.opendocument.text-template": `text`,
    "application/vnd.oasis.opendocument.text-master": `text`,
    "application/vnd.oasis.opendocument.spreadsheet": `spreadsheet`,
    "application/vnd.oasis.opendocument.spreadsheet-template": `spreadsheet`,
    "application/vnd.oasis.opendocument.presentation": `presentation`,
    "application/vnd.oasis.opendocument.presentation-template": `presentation`,
    "application/vnd.oasis.opendocument.graphics": `drawing`,
    "application/vnd.oasis.opendocument.graphics-template": `drawing`,
};

const PICTURE_TYPES: Readonly<Record<string, string>> = {
    png: `image/png`,
    jpg: `image/jpeg`,
    jpeg: `image/jpeg`,
    gif: `image/gif`,
    webp: `image/webp`,
    svg: `image/svg+xml`,
    bmp: `image/bmp`,
    avif: `image/avif`,
    tif: `image/tiff`,
    tiff: `image/tiff`,
};

export interface OdfPackage {
    readonly kind: OdfKind;
    readonly content: XmlElement | undefined;
    readonly styles: XmlElement | undefined;
    readonly title: string | undefined;
    /**
     * A blob URL for a picture stored inside the package, or undefined for one that lives elsewhere: a document must
     * not fetch a remote image, which would tell its host that this file was opened.
     */
    readonly image: (href: string) => string | undefined;
    /** Releases every blob URL handed out. Called when the viewer unmounts or opens another file. */
    readonly dispose: () => void;
}

const decoder = new TextDecoder();

// SVG is the one picture format that is also a script host, so it is served as a picture only where a browser
// refuses to run it: <img>, never an <object> or an inline document.
const typeOf = (path: string, declared: string | undefined): string =>
    declared ?? PICTURE_TYPES[path.slice(path.lastIndexOf(`.`) + 1).toLowerCase()] ?? `application/octet-stream`;

const mediaTypes = (manifest: XmlElement | undefined): Map<string, string> => {
    const types = new Map<string, string>();
    if (manifest === undefined) {
        return types;
    }
    for (const entry of descendants(manifest, `manifest:file-entry`)) {
        const path = entry.attrs.get(`manifest:full-path`);
        const type = entry.attrs.get(`manifest:media-type`);
        if (path !== undefined && type !== undefined && type !== ``) {
            types.set(path, type);
        }
    }
    return types;
};

export const openOdf = (bytes: Uint8Array): OdfPackage => {
    const zip = unzipSync(bytes);
    const part = (path: string): XmlElement | undefined => {
        const raw = zip[path];
        return raw === undefined ? undefined : parseXml(decoder.decode(raw));
    };
    const meta = part(`meta.xml`);
    const title = meta === undefined ? undefined : descendant(meta, `dc:title`);
    const types = mediaTypes(part(`META-INF/manifest.xml`));
    const urls = new Map<string, string>();

    return {
        kind: KINDS[decoder.decode(zip[`mimetype`] ?? new Uint8Array()).trim()] ?? `unknown`,
        content: part(`content.xml`),
        styles: part(`styles.xml`),
        title: title === undefined || textOf(title).trim() === `` ? undefined : textOf(title).trim(),
        image: (href) => {
            const path = href.startsWith(`./`) ? href.slice(2) : href;
            const bytesOf = zip[path];
            // An OLE object's replacement part (a chart saved as EMF) is in the package but is not a picture any
            // browser can draw; served as one it would be a broken-image icon on the slide.
            if (bytesOf === undefined || !typeOf(path, types.get(path)).startsWith(`image/`)) {
                return undefined;
            }
            const existing = urls.get(path);
            if (existing !== undefined) {
                return existing;
            }
            // Copied out of the zip's buffer: the Blob must own bytes that outlive this function's view of it.
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytesOf)], { type: typeOf(path, types.get(path)) }));
            urls.set(path, url);
            return url;
        },
        dispose: () => {
            for (const url of urls.values()) {
                URL.revokeObjectURL(url);
            }
            urls.clear();
        },
    };
};

/** The body element of a content.xml, whatever kind of document it is. */
export const bodyOf = (content: XmlElement | undefined, tag: string): XmlElement | undefined => {
    const body = content === undefined ? undefined : descendant(content, `office:body`);
    return body === undefined ? undefined : descendant(body, tag);
};

/** A length like `2.54cm` in centimetres, for the one place that has to do arithmetic on ODF lengths: slide layout. */
export const toCentimetres = (length: string | undefined, fallback: number): number => {
    if (length === undefined) {
        return fallback;
    }
    const match = /^(-?[\d.]+)(cm|mm|in|pt|pc|px)?$/.exec(length.trim());
    const value = Number.parseFloat(match?.[1] ?? ``);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    const perUnit: Readonly<Record<string, number>> = { cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6, px: 2.54 / 96 };
    return value * (perUnit[match?.[2] ?? `cm`] ?? 1);
};
