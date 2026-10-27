// The inline markup of a block the surface draws as its own source (sourceDom.ts): the spans that hold a construct's
// markup, so CSS can hide it at rest and show it with the caret in the block, and the passes over a built block that
// only wrap its text, never change it.

// Markup, as opposed to words: hidden while the block is at rest, revealed when the caret is in it.
export const MARKER = `md-marker`;

export const span = (text: string, ...classes: string[]): HTMLSpanElement => {
    const node = document.createElement(`span`);
    node.className = classes.join(` `);
    node.textContent = text;
    return node;
};

// An empty marker span is markup that isn't there. Removed so the DOM stays honest about the file's contents and
// the caret has nowhere empty to land.
export const dropEmptyMarkers = (root: HTMLElement): void => {
    for (const node of root.querySelectorAll(`.${MARKER}`)) {
        if (node.textContent === ``) {
            node.remove();
        }
    }
};

// `[[target]]` and `[[target|label]]`: the link notes write to each other (a knowledge base, an agent's memory). The lexer
// reads it as text, often in several pieces, so it is drawn after the block is built: a link whose brackets (and target,
// where a label stands in for it) are markup, reading as its words at rest and as its source with the caret in it. The
// block's text is untouched, only wrapped. Its target rides in `data-md-wiki`, for a host that knows what the names mean
// to follow; it names a note, not a URL, so nothing here offers to open it.
const WIKI_LINK = /\[\[([^\][|\n]+)(?:\|([^\]\n]+))?\]\]/gu;
// Where a `[[` is not a link: code, a block kept as its source, a rendering, markup already drawn.
const NOT_PROSE = `a, code, pre, .md-code-block, .md-src-verbatim, .md-rendered, .${MARKER}`;

const linkOf = (target: string, named: string | undefined): HTMLAnchorElement => {
    const anchor = document.createElement(`a`);
    anchor.dataset[`mdWiki`] = target.trim();
    if (named === undefined) {
        anchor.append(span(`[[`, MARKER), target, span(`]]`, MARKER));
    } else {
        anchor.append(span(`[[${target}|`, MARKER), named, span(`]]`, MARKER));
    }
    return anchor;
};

export const drawWikiLinks = (root: HTMLElement): void => {
    // One text node per run of text, so a link the inline pass left in pieces is one string again.
    root.normalize();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Text && node.data.includes(`[[`) && node.parentElement?.closest(NOT_PROSE) == null) {
            found.push(node);
        }
    }
    for (const text of found) {
        const parts = document.createDocumentFragment();
        let cursor = 0;
        for (const match of text.data.matchAll(WIKI_LINK)) {
            // No empty text node before a link that opens the run: it would be a place for the caret that holds nothing.
            if (match.index > cursor) {
                parts.append(text.data.slice(cursor, match.index));
            }
            parts.append(linkOf(match[1] ?? ``, match[2]));
            cursor = match.index + match[0].length;
        }
        if (cursor === 0) {
            continue;
        }
        if (cursor < text.data.length) {
            parts.append(text.data.slice(cursor));
        }
        text.replaceWith(parts);
    }
};
