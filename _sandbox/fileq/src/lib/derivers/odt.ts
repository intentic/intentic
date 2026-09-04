import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { bodyOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { attributeOf, decodeEntities } from "../xml.js";

/* OpenDocument text: a zip whose content.xml is the document, in ODF's own vocabulary (text:h, text:p,
 * text:list, table:table). Rather than a second markdown pen, that vocabulary is rewritten tag-for-tag into
 * the HTML it corresponds to and handed to webq's writer — the same road a docx takes through mammoth, so an
 * .odt and a .docx of the same letter cannot disagree about what a heading or a table looks like in
 * markdown. The rewrite is a tag-name substitution over well-formed, machine-written XML; no XML parser is
 * needed to rename elements, and every namespaced tag the table does not name is unwrapped (its text kept,
 * its tag dropped), so an unfamiliar wrapper can never swallow a paragraph. */

// ODF element → HTML element. An empty string is a void marker to drop (its text is nothing).
const TAG: Record<string, string> = {
    "text:p": "p",
    "text:list": "ul",
    "text:list-item": "li",
    "text:list-header": "li",
    "text:span": "span",
    "text:a": "a",
    "text:line-break": "br",
    "text:note-citation": "sup",
    "table:table": "table",
    "table:table-header-rows": "thead",
    "table:table-row": "tr",
    "table:table-cell": "td",
    "table:covered-table-cell": "td", // a merged-away cell: an empty td keeps the columns aligned
    "table:table-column": "col",
    "table:table-columns": "colgroup",
};

// Subtrees that are not the document's text: reviewer comments, tracked-change records, drawings' metadata,
// and index/TOC machinery whose visible entries ODF stores separately anyway.
const DROP_SUBTREE = [
    "office:annotation",
    "text:tracked-changes",
    "draw:frame",
    "text:table-of-content-source",
    "text:index-title-template",
    "text:alphabetical-index-source",
];

const dropSubtrees = (xml: string): string =>
    DROP_SUBTREE.reduce((text, tag) => text.replaceAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"), ""), xml);

/** content.xml's `<office:text>` body as the HTML webq's writer understands. Exported for the tests. */
export const odfToHtml = (xml: string): string => {
    const start = xml.indexOf("<office:text");
    const end = xml.lastIndexOf("</office:text>");
    const body = dropSubtrees(start === -1 || end === -1 ? xml : xml.slice(start, end));
    return (
        body
            // Headings carry their level as an attribute, so the pair is rewritten together (headings never nest).
            .replaceAll(/<text:h\b([^>]*)>([\s\S]*?)<\/text:h>/g, (_, attributes: string, inner: string) => {
                const level = Math.min(6, Math.max(1, Number(attributeOf(attributes, "text:outline-level") ?? "1") || 1));
                return `<h${level}>${inner}</h${level}>`;
            })
            // Whitespace elements: ODF writes runs of spaces and tabs as elements so XML cannot collapse them.
            .replaceAll(/<text:s\b([^>]*)\/>/g, (_, attributes: string) => " ".repeat(Number(attributeOf(attributes, "text:c") ?? "1") || 1))
            .replaceAll(/<text:tab\b[^>]*\/>/g, " ")
            // Everything namespaced: mapped tags become their HTML, the rest are unwrapped.
            .replaceAll(
                /<(\/?)([a-zA-Z0-9]+:[a-zA-Z0-9-]+)((?:\s[^>]*?)?)(\/?)>/g,
                (_, close: string, name: string, attributes: string, selfClosing: string) => {
                    const mapped = TAG[name];
                    if (mapped === undefined) {
                        return "";
                    }
                    if (close === "/") {
                        return `</${mapped}>`;
                    }
                    if (mapped === "a") {
                        const href = attributeOf(attributes, "xlink:href");
                        return href === undefined ? "<a>" : `<a href="${href.replaceAll('"', "&quot;")}">`;
                    }
                    return selfClosing === "/" && mapped !== "br" && mapped !== "col" ? `<${mapped}></${mapped}>` : `<${mapped}>`;
                },
            )
            // ODF puts every list item's text in a paragraph; in HTML a <p> inside <li> is a block, and the
            // writer renders it as a bullet on one line and the text on the next. Single-paragraph items are
            // the norm, so their paragraph is unwrapped; a rarer multi-paragraph item degrades to an indented
            // continuation, which reads correctly.
            .replaceAll(/<li>\s*<p>/g, "<li>")
            .replaceAll(/<\/p>\s*<\/li>/g, "</li>")
    );
};

export const odtDeriver: Deriver = {
    name: "odt",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const zip = unzipSync(new Uint8Array(await readFile(absPath)));
        const decoder = new TextDecoder();
        const content = zip["content.xml"];
        if (content === undefined) {
            return { markdown: "", notes: ["no content.xml in this OpenDocument container"] };
        }
        const meta = zip["meta.xml"];
        const titleMatch = meta === undefined ? null : /<dc:title>([\s\S]*?)<\/dc:title>/.exec(decoder.decode(meta));
        const title = titleMatch?.[1] === undefined || titleMatch[1].trim() === "" ? undefined : decodeEntities(titleMatch[1].trim());
        const body = bodyOf(parseHtml(`<html><body>${odfToHtml(decoder.decode(content))}</body></html>`));
        return { markdown: body === undefined ? "" : renderMarkdown(body), title, notes: [] };
    },
};
