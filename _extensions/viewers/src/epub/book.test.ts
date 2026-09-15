import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openEpub, resolveHref } from "./book";

/* What a book is made of: its order, its titles, and where each file it names actually lives in the zip. */

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const opf = (extra: string, spine: string): string => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Book</dc:title><dc:creator>A Writer</dc:creator></metadata>
<manifest>
<item id="one" href="text/one.xhtml" media-type="application/xhtml+xml"/>
<item id="two" href="text/two.xhtml" media-type="application/xhtml+xml"/>
<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
${extra}
</manifest>
<spine ${spine}><itemref idref="cover" linear="no"/><itemref idref="two"/><itemref idref="one"/></spine>
</package>`;

const NAV = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav>
<ol><li><a href="one.xhtml">Chapter One</a></li><li><a href="two.xhtml#top">Chapter Two</a></li></ol></nav></body></html>`;

const NCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
<navPoint><navLabel><text>Part One</text></navLabel><content src="text/one.xhtml"/>
<navPoint><navLabel><text>A section of it</text></navLabel><content src="text/two.xhtml"/></navPoint>
</navPoint></navMap></ncx>`;

const epub = (files: Record<string, string>): Uint8Array =>
    zipSync({
        mimetype: [strToU8(`application/epub+zip`), { level: 0 }],
        "META-INF/container.xml": strToU8(CONTAINER),
        "OEBPS/text/one.xhtml": strToU8(`<html><body><p>One</p></body></html>`),
        "OEBPS/text/two.xhtml": strToU8(`<html><body><p>Two</p></body></html>`),
        "OEBPS/text/cover.xhtml": strToU8(`<html><body/></html>`),
        ...Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
    });

describe(`resolveHref`, () => {
    it(`resolves a link against the file it was written in`, () => {
        expect(resolveHref(`OEBPS/text/ch1.xhtml`, `../images/plate.png`)).toBe(`OEBPS/images/plate.png`);
        expect(resolveHref(`OEBPS/content.opf`, `text/ch1.xhtml`)).toBe(`OEBPS/text/ch1.xhtml`);
        expect(resolveHref(`OEBPS/text/ch1.xhtml`, `./ch2.xhtml`)).toBe(`OEBPS/text/ch2.xhtml`);
    });

    it(`undoes the encoding a link carries, since a zip entry has none`, () => {
        expect(resolveHref(`OEBPS/text/ch1.xhtml`, `../images/a%20plate.png`)).toBe(`OEBPS/images/a plate.png`);
    });

    it(`drops the fragment, which names a place inside a file rather than a file`, () => {
        expect(resolveHref(`OEBPS/text/ch1.xhtml`, `ch2.xhtml#part-2`)).toBe(`OEBPS/text/ch2.xhtml`);
    });

    it(`reads an absolute path as one from the root of the package`, () => {
        expect(resolveHref(`OEBPS/text/ch1.xhtml`, `/OEBPS/style.css`)).toBe(`OEBPS/style.css`);
    });
});

describe(`openEpub`, () => {
    it(`reads the book's metadata and reading order, skipping what the spine marks non-linear`, () => {
        const book = openEpub(epub({ "OEBPS/content.opf": opf(`<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`, ``), "OEBPS/nav.xhtml": NAV }));
        expect(book.title).toBe(`The Book`);
        expect(book.author).toBe(`A Writer`);
        // Spine order, not manifest order; the cover is `linear="no"` and is not part of the reading order.
        expect(book.chapters.map((chapter) => chapter.path)).toEqual([`OEBPS/text/two.xhtml`, `OEBPS/text/one.xhtml`]);
    });

    it(`titles chapters from an EPUB 3 navigation document`, () => {
        const book = openEpub(epub({ "OEBPS/content.opf": opf(`<item id="nav" href="text/nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>`, ``), "OEBPS/text/nav.xhtml": NAV }));
        expect(book.chapters.map((chapter) => chapter.title)).toEqual([`Chapter Two`, `Chapter One`]);
    });

    it(`titles chapters from an EPUB 2 NCX, each with its own label rather than its children's`, () => {
        const book = openEpub(epub({ "OEBPS/content.opf": opf(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`, `toc="ncx"`), "OEBPS/toc.ncx": NCX }));
        expect(book.chapters.map((chapter) => chapter.title)).toEqual([`A section of it`, `Part One`]);
    });

    it(`falls back to the file's name when the book names no title for it`, () => {
        const book = openEpub(epub({ "OEBPS/content.opf": opf(``, ``) }));
        expect(book.chapters.map((chapter) => chapter.title)).toEqual([`two.xhtml`, `one.xhtml`]);
    });

    it(`hands out a chapter's bytes and its media type`, () => {
        const book = openEpub(epub({ "OEBPS/content.opf": opf(``, ``) }));
        expect(new TextDecoder().decode(book.entry(`OEBPS/text/one.xhtml`))).toContain(`One`);
        expect(book.mediaType(`OEBPS/images/a.png`)).toBe(`image/png`);
        expect(book.entry(`OEBPS/missing.xhtml`)).toBeUndefined();
    });

    it(`says so plainly when the file is a zip but not a book`, () => {
        expect(() => openEpub(zipSync({ "hello.txt": strToU8(`hi`) }))).toThrow(/no EPUB package document/);
    });
});
