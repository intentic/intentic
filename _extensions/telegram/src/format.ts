// Markdown as an agent writes it, turned into the HTML subset Telegram renders (`parse_mode: "HTML"`): bold, italic,
// strikethrough, inline code, code blocks with their language, links, quotes. Headings become bold lines and list
// markers bullets, since Telegram has neither. Telegram refuses a message whose tags do not balance, so every tag here
// is written as a pair around one match; a message it still refuses is sent as the plain text it came from.

export const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const attribute = (text: string): string => escapeHtml(text).replaceAll('"', "&quot;");

// One line's inline markup, outside code spans. The text is escaped first: no Markdown marker is one of &, < or >.
const spans = (text: string): string =>
    escapeHtml(text)
        .replaceAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`)
        .replaceAll(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
        .replaceAll(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, "$1<b>$2</b>")
        .replaceAll(/~~([^~\n]+?)~~/g, "<s>$1</s>")
        .replaceAll(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?=[^*\w]|$)/g, "$1<i>$2</i>")
        .replaceAll(/(^|[^\w])_([^_\s][^_\n]*?)_(?=[^\w]|$)/g, "$1<i>$2</i>");

// A line's inline markup with its code spans kept verbatim.
const inline = (line: string): string =>
    line
        .split(/(`[^`\n]+`)/g)
        .map((part) => (part.length > 1 && part.startsWith("`") && part.endsWith("`") ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : spans(part)))
        .join("");

const HEADING = /^#{1,6}\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;

// Prose between code blocks, line by line: headings, quotes (consecutive lines kept in one quote), bullets, the rest.
const prose = (text: string): string => {
    const out: string[] = [];
    let quote: string[] = [];
    const endQuote = (): void => {
        if (quote.length > 0) {
            out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
            quote = [];
        }
    };
    for (const line of text.split("\n")) {
        const quoted = QUOTE.exec(line);
        if (quoted !== null) {
            quote.push(inline(quoted[1] ?? ""));
            continue;
        }
        endQuote();
        const heading = HEADING.exec(line);
        const bullet = BULLET.exec(line);
        if (heading !== null) {
            out.push(`<b>${inline(heading[1] ?? "")}</b>`);
        } else if (bullet !== null) {
            out.push(`${bullet[1] ?? ""}• ${inline(bullet[2] ?? "")}`);
        } else {
            out.push(inline(line));
        }
    }
    endQuote();
    return out.join("\n");
};

const FENCE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;

export const toTelegramHtml = (markdown: string): string => {
    const out: string[] = [];
    let at = 0;
    for (const match of markdown.matchAll(FENCE)) {
        out.push(prose(markdown.slice(at, match.index)));
        const language = match[1] ?? "";
        const body = escapeHtml((match[2] ?? "").replace(/\n$/, ""));
        out.push(language === "" ? `<pre>${body}</pre>` : `<pre><code class="language-${attribute(language)}">${body}</code></pre>`);
        at = match.index + match[0].length;
    }
    out.push(prose(markdown.slice(at)));
    return out.join("");
};
