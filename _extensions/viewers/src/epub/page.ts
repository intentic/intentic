import type { EpubBook } from "./book";
import { resolveHref } from "./book";

/* One chapter, ready for a sandboxed frame: its own markup and stylesheet, with every resource it needs carried
   inside the document as data. Nothing in here may leave the frame or reach the network. */

// Everything the chapter is allowed to do, stated twice over: the frame carries no `allow-scripts`, and this refuses
// every fetch a stylesheet or an <img> could otherwise make to a server that would learn the book was opened.
const POLICY = `default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline' data:`;

const STRIPPED = `script, iframe, object, embed, noscript, link, base, meta, form, input, button`;

// Pictures a chapter carries are inlined; past this one is a book's own problem rather than a preview's.
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const CHUNK = 0x8000;

const base64 = (bytes: Uint8Array): string => {
    let binary = ``;
    for (let index = 0; index < bytes.length; index += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
    }
    return btoa(binary);
};

const dataUrl = (book: EpubBook, path: string): string | undefined => {
    const bytes = book.entry(path);
    if (bytes === undefined || bytes.length === 0 || bytes.length > MAX_INLINE_BYTES) {
        return undefined;
    }
    return `data:${book.mediaType(path)};base64,${base64(bytes)}`;
};

// url(...) inside a stylesheet: a font or a background that has to travel with the text.
const inlineCssUrls = (css: string, book: EpubBook, from: string): string =>
    css.replaceAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, href: string) => {
        if (href.startsWith(`data:`)) {
            return whole;
        }
        const inlined = dataUrl(book, resolveHref(from, href));
        return inlined === undefined ? `url()` : `url("${inlined}")`;
    });

const styleSheets = (doc: Document, book: EpubBook, path: string): string => {
    const sheets: string[] = [];
    for (const link of doc.querySelectorAll(`link[rel~="stylesheet"]`)) {
        const href = link.getAttribute(`href`);
        const target = href === null ? `` : resolveHref(path, href);
        const bytes = target === `` ? undefined : book.entry(target);
        if (bytes !== undefined) {
            sheets.push(inlineCssUrls(new TextDecoder().decode(bytes), book, target));
        }
    }
    for (const style of doc.querySelectorAll(`style`)) {
        sheets.push(inlineCssUrls(style.textContent ?? ``, book, path));
        style.remove();
    }
    return sheets.join(`\n`);
};

const SRC_ATTRIBUTES = [`src`, `href`, `xlink:href`, `data`, `poster`];

const inlineResources = (doc: Document, book: EpubBook, path: string): void => {
    for (const element of doc.querySelectorAll(`img, image, source, video, audio`)) {
        for (const name of SRC_ATTRIBUTES) {
            const value = element.getAttribute(name);
            if (value === null || value.startsWith(`data:`)) {
                continue;
            }
            const inlined = dataUrl(book, resolveHref(path, value));
            if (inlined === undefined) {
                element.removeAttribute(name);
                continue;
            }
            element.setAttribute(name, inlined);
        }
        element.removeAttribute(`srcset`);
    }
};

// A link inside the frame can go nowhere: the sandbox refuses navigation, and a chapter reference means nothing to
// a browser that was handed one chapter. The text stays, the target goes.
const defuse = (doc: Document): void => {
    for (const element of doc.querySelectorAll(STRIPPED)) {
        element.remove();
    }
    for (const element of doc.querySelectorAll(`*`)) {
        // Names first, then removal: the attribute list is live, and removing while walking it skips entries.
        for (const handler of element.getAttributeNames().filter((attribute) => attribute.toLowerCase().startsWith(`on`))) {
            element.removeAttribute(handler);
        }
    }
    for (const anchor of doc.querySelectorAll(`a`)) {
        anchor.removeAttribute(`href`);
        anchor.removeAttribute(`target`);
    }
};

const READER_CSS = `
html { color-scheme: light; }
body { margin: 0; padding: 2.5rem 1.5rem 4rem; max-width: 40rem; margin-inline: auto;
       background: #fff; color: #111; font-family: Georgia, serif; line-height: 1.55; }
img, svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
`;

const parse = (text: string, declared: string): Document => {
    const parser = new DOMParser();
    const asXml = declared.includes(`xhtml`) || declared.includes(`xml`);
    const parsed = asXml ? parser.parseFromString(text, `application/xhtml+xml`) : parser.parseFromString(text, `text/html`);
    // An EPUB 3 chapter may be served as XHTML and still be written as HTML; a parse error there is not the end.
    return parsed.querySelector(`parsererror`) === null ? parsed : parser.parseFromString(text, `text/html`);
};

/** A chapter as one self-contained HTML document, for an iframe's `srcdoc`. */
export const renderChapter = (book: EpubBook, path: string): string => {
    const bytes = book.entry(path);
    if (bytes === undefined) {
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"></head><body></body></html>`;
    }
    const doc = parse(new TextDecoder().decode(bytes), book.mediaType(path));
    const css = styleSheets(doc, book, path);
    inlineResources(doc, book, path);
    defuse(doc);
    const body = doc.body?.innerHTML ?? ``;
    return [
        `<!DOCTYPE html><html><head><meta charset="utf-8">`,
        `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
        `<style>${READER_CSS}</style>`,
        css === `` ? `` : `<style>${css}</style>`,
        `</head><body>${body}</body></html>`,
    ].join(``);
};
