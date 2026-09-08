import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { bodyOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { attributeOf, decodeEntities } from "../xml.js";

// ODF's content.xml is rewritten tag-for-tag into HTML and handed to webq's writer, the same road docx takes through
// mammoth, so an .odt and .docx of the same letter render the same markdown.
// A tag-name substitution over well-formed XML, no parser needed to rename elements; every namespaced tag the table
// doesn't name is unwrapped, keeping its text but dropping the tag.

// ODF element to HTML element; an empty value is a void marker to drop, since its text is nothing.
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

// Subtrees that aren't the document's text: comments, tracked changes, drawing metadata, TOC machinery.
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

/** content.xml's <office:text> body as the HTML webq's writer understands; exported for tests. */
export const odfToHtml = (xml: string): string => {
    const start = xml.indexOf("<office:text");
    const end = xml.lastIndexOf("</office:text>");
    const body = dropSubtrees(start === -1 || end === -1 ? xml : xml.slice(start, end));
    return (
        body
            // Headings carry level as an attribute, so tag and level are rewritten together (headings never nest).
            .replaceAll(/<text:h\b([^>]*)>([\s\S]*?)<\/text:h>/g, (_, attributes: string, inner: string) => {
                const level = Math.min(6, Math.max(1, Number(attributeOf(attributes, "text:outline-level") ?? "1") || 1));
                return `<h${level}>${inner}</h${level}>`;
            })
            // ODF writes runs of spaces/tabs as elements, since XML would otherwise collapse them.
            .replaceAll(/<text:s\b([^>]*)\/>/g, (_, attributes: string) => " ".repeat(Number(attributeOf(attributes, "text:c") ?? "1") || 1))
            .replaceAll(/<text:tab\b[^>]*\/>/g, " ")
            // Namespaced tags: mapped ones become their HTML, the rest are unwrapped.
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
            // A list item's single paragraph is unwrapped, since <p> inside <li> would render as bullet then text
            // below.
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
