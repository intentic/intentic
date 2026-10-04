// Markdown to WhatsApp's own marks, for every text this gateway sends. Models write markdown out of habit whatever the
// prompt says, and WhatsApp shows it literally: `**bold**` arrives with its asterisks, a `[link](url)` as brackets.
// Only what is unambiguously markdown is rewritten. A single `*word*` is left alone: in WhatsApp that already IS bold,
// and the skill tells the model to use it. Code (fenced or inline) passes through untouched, as WhatsApp renders both.

const FENCE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

const rewrite = (text: string): string =>
    text
        // Images, then links: WhatsApp previews a bare URL, it renders nothing for the brackets.
        .replaceAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_all, alt: string, url: string) => (alt.trim() === "" ? url : `${alt} (${url})`))
        .replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) => {
            const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
            return label === url || label === bare ? url : `${label} (${url})`;
        })
        // Headings become a bold line, without the markers a heading's own bold would leave doubled.
        .replaceAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_all, heading: string) => `*${heading.replaceAll("**", "").replaceAll("__", "")}*`)
        .replaceAll(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "*$1*")
        .replaceAll(/__(?=\S)([\s\S]*?\S)__/g, "_$1_")
        .replaceAll(/~~(?=\S)([\s\S]*?\S)~~/g, "~$1~");

export const toWhatsAppText = (text: string): string => {
    let out = "";
    let last = 0;
    for (const match of text.matchAll(FENCE)) {
        out += rewrite(text.slice(last, match.index)) + match[0];
        last = match.index + match[0].length;
    }
    return out + rewrite(text.slice(last));
};
