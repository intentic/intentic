import { bodyOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Word documents: mammoth maps the docx to semantic HTML (headings, lists, tables — its whole reason to exist). */

// mammoth is 0.26s to load, and only a Word document needs it; see xlsx.ts for why that is loaded inside derive().

// A style mammoth's map does not name still yields its text, as a plain paragraph or run; what the reader loses is
// the heading or emphasis that style stood for, the same loss for every such style. One line says it; the style
// names would not, and a corporate template carries dozens, renumbered by every application that re-saves the file.
const STYLE_WARNING = /^Unrecognised (?:paragraph|run|table) style: '(.*)' \(Style ID: /;

// Every other warning is a piece of content the markdown lacks (an element it dropped, an image it could not carry)
// and stays a line of its own, up to this many.
const MAX_NOTES = 5;

/** The notes of a conversion, from mammoth's messages; exported for tests. */
export const notesOf = (messages: readonly { readonly message: string }[]): string[] => {
    const distinct = [...new Set(messages.map((message) => message.message))];
    // Counted by name, not id: the same template re-saved by another application renumbers every id.
    const styles = new Set(distinct.flatMap((warning) => STYLE_WARNING.exec(warning)?.[1] ?? []));
    const others = distinct.filter((warning) => !STYLE_WARNING.test(warning));
    const notes = others.slice(0, MAX_NOTES).map((warning) => `docx conversion: ${warning}`);
    if (others.length > MAX_NOTES) {
        notes.push(`docx conversion: ${others.length - MAX_NOTES} more warnings of the same kind`);
    }
    if (styles.size > 0) {
        notes.push(`docx conversion: ${styles.size} Word style${styles.size === 1 ? "" : "s"} without a markdown equivalent, read as plain text`);
    }
    return notes;
};

export const docxDeriver: Deriver = {
    name: "docx",
    version: 2,
    derive: async (absPath): Promise<DerivedDoc> => {
        const { default: mammoth } = await import("mammoth");
        const converted = await mammoth.convertToHtml({ path: absPath });
        const body = bodyOf(parseHtml(converted.value));
        const markdown = body === undefined ? "" : renderMarkdown(body);
        return { markdown, notes: notesOf(converted.messages) };
    },
};
