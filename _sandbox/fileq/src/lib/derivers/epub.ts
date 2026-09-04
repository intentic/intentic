import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { unzipSync, type Unzipped } from "fflate";
import { bodyOf, metaOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { attributeOf, decodeEntities } from "../xml.js";

/* EPUBs: a zip of XHTML chapters, read in the order the package document (the OPF) says they are read.
 * Each chapter goes through webq's writer like any HTML, under a heading of its own so a reader can find
 * chapter twelve in the sidecar. A book is the one format here that is routinely longer than an agent wants
 * whole, so the body is capped in bytes and the cap is announced — the sidecar still says what the book IS
 * and where it was cut, and `fileq read`'s own budget does the rest. */

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

interface ManifestItem {
    readonly href: string;
    readonly mediaType: string;
    readonly nav: boolean;
}

interface Package {
    readonly dir: string;
    readonly title: string | undefined;
    readonly manifest: Map<string, ManifestItem>;
    readonly spine: string[];
}

const decoder = new TextDecoder();

const partOf = (zip: Unzipped, name: string): string | undefined => (zip[name] === undefined ? undefined : decoder.decode(zip[name]));

const manifestOf = (opf: string): Map<string, ManifestItem> => {
    const items = new Map<string, ManifestItem>();
    for (const match of opf.matchAll(/<(?:opf:)?item\b([^>]*?)\/?>/g)) {
        const attributes = match[1] ?? "";
        const id = attributeOf(attributes, "id");
        const href = attributeOf(attributes, "href");
        if (id !== undefined && href !== undefined) {
            items.set(id, {
                href,
                mediaType: attributeOf(attributes, "media-type") ?? "",
                nav: (attributeOf(attributes, "properties") ?? "").split(/\s+/).includes("nav"),
            });
        }
    }
    return items;
};

const spineOf = (opf: string): string[] =>
    [...opf.matchAll(/<(?:opf:)?itemref\b([^>]*?)\/?>/g)]
        .map((match) => attributeOf(match[1] ?? "", "idref"))
        .filter((idref): idref is string => idref !== undefined);

// container.xml names the OPF; the OPF names everything else. Undefined when either is missing.
const readPackage = (zip: Unzipped): Package | undefined => {
    const container = partOf(zip, "META-INF/container.xml");
    const opfPath = container === undefined ? undefined : /full-path\s*=\s*"([^"]+)"/.exec(container)?.[1];
    const opf = opfPath === undefined ? undefined : partOf(zip, opfPath);
    if (opfPath === undefined || opf === undefined) {
        return undefined;
    }
    const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf);
    const raw = titleMatch?.[1]?.trim() ?? "";
    return { dir: posix.dirname(opfPath), title: raw === "" ? undefined : decodeEntities(raw), manifest: manifestOf(opf), spine: spineOf(opf) };
};

// One spine entry as a markdown section: undefined when it is not a chapter (the nav document, a stylesheet,
// an empty page); "missing" when the package names a file the archive does not carry.
const chapterOf = (zip: Unzipped, pkg: Package, idref: string): string | "missing" | undefined => {
    const item = pkg.manifest.get(idref);
    if (item === undefined || item.nav || !/x?html/.test(item.mediaType)) {
        return undefined;
    }
    const path = posix.normalize(posix.join(pkg.dir, decodeURIComponent(item.href.split("#")[0] ?? item.href)));
    const html = partOf(zip, path);
    if (html === undefined) {
        return "missing";
    }
    const doc = parseHtml(html);
    const body = bodyOf(doc);
    const markdown = body === undefined ? "" : renderMarkdown(body).trim();
    if (markdown === "") {
        return undefined;
    }
    return markdown.startsWith("#") ? markdown : `## ${metaOf(doc).title || posix.basename(path)}\n\n${markdown}`;
};

const notesOf = (rendered: number, chapters: number, missing: number, capped: boolean): string[] => {
    const notes: string[] = [];
    if (capped) {
        notes.push(`showing ${rendered} of ${chapters} chapters: cut at ${Math.round(MAX_MARKDOWN_BYTES / 1024 / 1024)} MB of text`);
    }
    if (missing > 0) {
        notes.push(`${missing} spine item${missing === 1 ? "" : "s"} named in the package but absent from the archive`);
    }
    if (chapters === 0) {
        notes.push("no readable chapters in this EPUB");
    }
    return notes;
};

export const epubDeriver: Deriver = {
    name: "epub",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const zip = unzipSync(new Uint8Array(await readFile(absPath)));
        const pkg = readPackage(zip);
        if (pkg === undefined) {
            return { markdown: "", notes: ["no package document (OPF) found: META-INF/container.xml is missing or points nowhere"] };
        }
        const sections: string[] = [];
        let bytes = 0;
        let chapters = 0;
        let missing = 0;
        for (const idref of pkg.spine) {
            const chapter = chapterOf(zip, pkg, idref);
            if (chapter === undefined) {
                continue;
            }
            if (chapter === "missing") {
                missing += 1;
                continue;
            }
            chapters += 1;
            if (bytes < MAX_MARKDOWN_BYTES) {
                sections.push(chapter); // past the cap a chapter is counted, not rendered, so the note can say how many
                bytes += chapter.length;
            }
        }
        return { markdown: sections.join("\n\n"), title: pkg.title, notes: notesOf(sections.length, chapters, missing, bytes >= MAX_MARKDOWN_BYTES) };
    },
};
