import { unzipSync } from "fflate";
import { attr, child, childElements, descendants, parseXml, textOf, type XmlElement } from "../odf/xml";

/* An EPUB's structure: what it is, what is in it, and in what order. Reading a chapter's markup is page.ts's job. */

export interface Chapter {
    /** Zip path, already resolved against the package document's own directory. */
    readonly path: string;
    readonly title: string;
}

export interface EpubBook {
    readonly title: string;
    readonly author: string | undefined;
    readonly chapters: readonly Chapter[];
    readonly entry: (path: string) => Uint8Array | undefined;
    readonly mediaType: (path: string) => string;
}

const decoder = new TextDecoder();

const TYPES: Readonly<Record<string, string>> = {
    xhtml: `application/xhtml+xml`,
    html: `text/html`,
    css: `text/css`,
    png: `image/png`,
    jpg: `image/jpeg`,
    jpeg: `image/jpeg`,
    gif: `image/gif`,
    webp: `image/webp`,
    svg: `image/svg+xml`,
    avif: `image/avif`,
    otf: `font/otf`,
    ttf: `font/ttf`,
    woff: `font/woff`,
    woff2: `font/woff2`,
};

/**
 * A zip path for `href` as written inside `base`'s file. Hrefs are URL-encoded and may climb out of their own
 * directory; zip entries are neither encoded nor relative, so both have to be undone before a lookup.
 */
export const resolveHref = (base: string, href: string): string => {
    const clean = decodeURIComponent(href.split(`#`)[0] ?? ``);
    if (clean === ``) {
        return ``;
    }
    if (clean.startsWith(`/`)) {
        return clean.slice(1);
    }
    const parts = base.split(`/`).slice(0, -1);
    for (const segment of clean.split(`/`)) {
        if (segment === `..`) {
            parts.pop();
            continue;
        }
        if (segment !== `.` && segment !== ``) {
            parts.push(segment);
        }
    }
    return parts.join(`/`);
};

interface ManifestItem {
    readonly href: string;
    readonly properties: string;
    readonly type: string;
}

const manifestOf = (opf: XmlElement): Map<string, ManifestItem> => {
    const manifest = new Map<string, ManifestItem>();
    for (const item of descendants(opf, `opf:item`)) {
        const id = attr(item, `id`);
        const href = attr(item, `href`);
        if (id !== undefined && href !== undefined) {
            manifest.set(id, { href, properties: attr(item, `properties`) ?? ``, type: attr(item, `media-type`) ?? `` });
        }
    }
    return manifest;
};

const spineOrder = (opf: XmlElement, opfPath: string): { readonly paths: string[]; readonly tocPath: string | undefined } => {
    const manifest = manifestOf(opf);
    const spine = descendants(opf, `opf:spine`)[0];
    const paths = childElements(spine ?? opf)
        .filter((item) => item.tag === `opf:itemref` && attr(item, `linear`) !== `no`)
        .map((item) => manifest.get(attr(item, `idref`) ?? ``)?.href)
        .filter((href): href is string => href !== undefined)
        .map((href) => resolveHref(opfPath, href));

    // EPUB 3 marks its table of contents in the manifest; EPUB 2 names it on the spine as an NCX.
    const navigation = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes(`nav`));
    const ncx = manifest.get(attr(spine, `toc`) ?? ``) ?? [...manifest.values()].find((item) => item.type === `application/x-dtbncx+xml`);
    const toc = navigation ?? ncx;
    return { paths, tocPath: toc === undefined ? undefined : resolveHref(opfPath, toc.href) };
};

// Titles from the book's own table of contents, keyed by the file each entry points at.
const tocTitles = (root: XmlElement, tocPath: string): Map<string, string> => {
    const titles = new Map<string, string>();
    const remember = (href: string | undefined, label: string): void => {
        const target = href === undefined ? `` : resolveHref(tocPath, href);
        if (target !== `` && label.trim() !== `` && !titles.has(target)) {
            titles.set(target, label.trim().replaceAll(/\s+/g, ` `));
        }
    };
    for (const anchor of descendants(root, `html:a`)) {
        remember(attr(anchor, `href`), textOf(anchor));
    }
    for (const point of descendants(root, `ncx:navPoint`)) {
        // This point's OWN label: navPoints nest, and reading the whole subtree would title chapter one with the
        // text of every chapter under it.
        const label = child(point, `ncx:navLabel`);
        remember(attr(child(point, `ncx:content`), `src`), label === undefined ? `` : textOf(label));
    }
    return titles;
};

const metadataOf = (opf: XmlElement, tag: string): string | undefined => {
    const element = descendants(opf, tag)[0];
    const value = element === undefined ? `` : textOf(element).trim();
    return value === `` ? undefined : value;
};

const fileName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);

/** Opens an .epub. Throws when the container is not an EPUB at all, which the viewer reports as such. */
export const openEpub = (bytes: Uint8Array): EpubBook => {
    const zip = unzipSync(bytes);
    const part = (path: string): XmlElement | undefined => {
        const raw = zip[path];
        return raw === undefined ? undefined : parseXml(decoder.decode(raw));
    };
    const container = part(`META-INF/container.xml`);
    const opfPath = container === undefined ? undefined : attr(descendants(container, `container:rootfile`)[0], `full-path`);
    const opf = opfPath === undefined ? undefined : part(opfPath);
    if (opf === undefined || opfPath === undefined) {
        throw new Error(`This file has no EPUB package document in it.`);
    }

    const { paths, tocPath } = spineOrder(opf, opfPath);
    const tocRoot = tocPath === undefined ? undefined : part(tocPath);
    const titles = tocRoot === undefined || tocPath === undefined ? new Map<string, string>() : tocTitles(tocRoot, tocPath);

    return {
        title: metadataOf(opf, `dc:title`) ?? `Untitled`,
        author: metadataOf(opf, `dc:creator`),
        chapters: paths.map((path) => ({ path, title: titles.get(path) ?? fileName(path) })),
        entry: (path) => zip[path],
        mediaType: (path) => TYPES[path.slice(path.lastIndexOf(`.`) + 1).toLowerCase()] ?? `application/octet-stream`,
    };
};
