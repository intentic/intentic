import type { PrivacyShieldedValue } from "@intentic/sandbox-contract/schemas/privacy";
import type { RenderedMarkdown } from "../../../../lib/markdown/renderMarkdown";

// THE WORDS A REPLY'S MODEL NEVER READ. Behind the privacy shield the model reads `⟦PERSON_3⟧` where a name stood and
// writes the token back; the daemon puts the name in before the reply reaches the chat. Read plainly, that is a model
// quoting a name it was never told, so each such value is marked where it stands (a dotted underline, `chat.css`) and
// its hover says what the model read instead (privacy.shielded names them). Marked in the rendered prose rather than the
// source, so a value is found as the reader sees it, whatever markdown it sat in.

export const SHIELDED_ATTRIBUTE = `data-shielded`;

const escapeHtml = (text: string): string =>
    text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`).replaceAll(`"`, `&quot;`).replaceAll(`'`, `&#39;`);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, `\\$&`);

// Every value as a whole word, the longest first, so "Anna Nowak" is marked whole rather than "Anna" inside it.
const patternOf = (values: readonly PrivacyShieldedValue[]): RegExp =>
    new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${[...values]
            .sort((left, right) => right.text.length - left.text.length)
            .map((value) => escapeRegExp(value.text))
            .join(`|`)})(?![\\p{L}\\p{N}])`,
        `gu`,
    );

// Wraps each value in the fragment's text in a mark carrying its token. A code block is still its placeholder here, and
// a value split across two elements (half of it bold) is left as it is.
const markShieldedIn = (root: DocumentFragment | Element, values: readonly PrivacyShieldedValue[]): void => {
    const doc = root.ownerDocument ?? document;
    const tokens = new Map(values.map((value) => [value.text, value.token]));
    const pattern = patternOf(values);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // Collected before any rewriting: replacing a node mid-walk loses the walker's place.
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Text && node.parentElement?.closest(`pre, [${SHIELDED_ATTRIBUTE}]`) == null) {
            texts.push(node);
        }
    }
    for (const text of texts) {
        const words = text.data;
        const parts = doc.createDocumentFragment();
        let taken = 0;
        for (const match of words.matchAll(pattern)) {
            const token = tokens.get(match[0]);
            if (token === undefined) {
                continue;
            }
            parts.append(words.slice(taken, match.index));
            const mark = doc.createElement(`span`);
            mark.className = `chat-shielded`;
            mark.setAttribute(SHIELDED_ATTRIBUTE, token);
            mark.textContent = match[0];
            parts.append(mark);
            taken = match.index + match[0].length;
        }
        if (taken > 0) {
            parts.append(words.slice(taken));
            text.replaceWith(parts);
        }
    }
};

// The rendered parts with their values marked. A part none of the values stands in is handed back as it was, so a reply
// without any is never parsed again and Vue patches nothing.
export const markShielded = (parts: RenderedMarkdown, values: readonly PrivacyShieldedValue[]): RenderedMarkdown => {
    if (values.length === 0) {
        return parts;
    }
    const spelled = values.map((value) => escapeHtml(value.text));
    return parts.map((part) => {
        if (part.kind !== `html` || !spelled.some((text) => part.html.includes(text))) {
            return part;
        }
        const template = document.createElement(`template`);
        template.innerHTML = part.html;
        markShieldedIn(template.content, values);
        return { kind: `html`, html: template.innerHTML };
    });
};
