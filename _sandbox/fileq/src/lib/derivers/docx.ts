import mammoth from "mammoth";
import { bodyOf, parseHtml } from "@intentic/webq/dom";
import { renderMarkdown } from "@intentic/webq/markdown";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Word documents: mammoth maps the docx to semantic HTML (headings, lists, tables — its whole reason to exist). */

// mammoth emits a warning per construct it cannot map. On a heavily-styled corporate document that is dozens
// of near-identical lines; a handful tells the reader the conversion was lossy, a wall of them buries it.
const MAX_NOTES = 5;

export const docxDeriver: Deriver = {
    name: "docx",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const converted = await mammoth.convertToHtml({ path: absPath });
        const body = bodyOf(parseHtml(converted.value));
        const markdown = body === undefined ? "" : renderMarkdown(body);
        const warnings = [...new Set(converted.messages.map((message) => message.message))];
        const notes = warnings.slice(0, MAX_NOTES).map((warning) => `docx conversion: ${warning}`);
        if (warnings.length > MAX_NOTES) {
            notes.push(`docx conversion: ${warnings.length - MAX_NOTES} more warnings of the same kind`);
        }
        return { markdown, notes };
    },
};
