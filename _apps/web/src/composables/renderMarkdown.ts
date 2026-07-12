import DOMPurify from "dompurify";
import { marked } from "marked";

/* Render untrusted markdown (workspace files, agent chat output) to SANITIZED HTML for v-html. Vue's v-html
 * does NOT sanitize, so we must do it ourselves — marked passes inline HTML through, so without this a
 * workspace file or a crafted agent turn could inject <script>/onerror. DOMPurify strips the active markup
 * while keeping the prose. */

// Minimal HTML escape for the fallback path — enough to render arbitrary text inertly inside v-html.
const escapeHtml = (text: string): string => text.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`).replace(/"/g, `&quot;`);

// Never let a markdown/sanitizer edge case (or a non-string slipping in mid-stream) crash the surrounding
// component — a chat bubble re-renders this on every streamed delta, so a single throw would blank the turn.
// On any failure, fall back to the raw text, HTML-escaped, so the content still shows (just unstyled).
export const renderMarkdown = (source: string): string => {
    const text = typeof source === `string` ? source : String(source ?? ``);
    try {
        return DOMPurify.sanitize(marked.parse(text, { async: false }));
    } catch {
        return escapeHtml(text);
    }
};
