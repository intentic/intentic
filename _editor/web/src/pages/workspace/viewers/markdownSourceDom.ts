import { lexBlocks, lexInline, type MarkdownToken } from "@intentic/ui/markdown";

/* A MARKDOWN DOCUMENT AS EDITABLE DOM, where the document's own source text is the DOM's text.
 *
 * This is the editing half of the markdown surface, and the whole design is one invariant:
 *
 *      blockBody(element) === that block's markdown source, exactly, byte for byte.
 *
 * Every character of the file is in a text node, in document order, including the markup: the `##` of a heading,
 * the `**` around a bold run, the `- ` of a list item. What makes it look like a rendered document rather than a
 * screen of source is that those marker characters are wrapped in spans the CSS can hide, and that the content
 * around them is still marked up (`<strong>`, `<em>`, `<code>`, `<a>`) so it is still styled.
 *
 * WITH ONE EXCEPTION, WHICH THE BROWSER FORCED. A newline that ends a line is whitespace at a line boundary, so
 * it is not rendered, and a `contenteditable` deletes what it does not render: typing at the end of a list item
 * welded it to the item below. Those newlines therefore live in the block's SHAPE (one element per line) rather
 * than in its text, and `blockBody` puts them back. Whitespace between words is rendered, and is safe, which is
 * why a paragraph's own soft wrap stays an ordinary character in an ordinary text node.
 *
 * THREE THINGS FALL OUT OF THAT INVARIANT, and they are the three things that were wrong with the surface this
 * replaces:
 *
 *   Reading an edit back is `blockBody`. No serializer, no rich model, no rewriting a file the moment somebody
 *   fixes a typo in it. `contenteditable` mutates text nodes; the text nodes are the source.
 *
 *   A caret position IS a source offset, found by counting text-node lengths in document order. The previous
 *   surface had to GUESS where a click landed by searching the rendered words back through the markdown; that
 *   guess is gone, along with the class of bug where it guessed wrong.
 *
 *   Activating a block is a CSS class, not a swap. The markers are already there, taking their space; revealing
 *   them changes their visibility, not the layout. Nothing is torn down, nothing is rebuilt, nothing flickers,
 *   and the text does not move. That is the property VS Code's hybrid editor is built around, and the reason
 *   its markers hang in the gutter rather than sitting in the line.
 *
 * WHEN THE MARKUP CANNOT BE READ, THE TEXT STILL CAN. Every builder below is checked against the invariant
 * before it is returned: if the pieces do not reassemble the source exactly, the block falls back to one plain
 * text node holding its source. That block then looks like source rather than like prose, which is a cosmetic
 * loss; the alternative, a DOM whose text is not the file, is a corrupted save. Same trade as the block
 * splitter's whole-document fallback, one level down. */

// Markup, as opposed to words: hidden while the block is at rest, revealed when the caret is in it.
const MARKER = `md-marker`;
// The leading markup of a line (`## `, `- `, `> `), which hangs in the gutter so revealing it never moves the
// text it introduces. See markdown-editing.css.
const GUTTER = `md-marker-gutter`;

const span = (text: string, ...classes: string[]): HTMLSpanElement => {
    const node = document.createElement(`span`);
    node.className = classes.join(` `);
    node.textContent = text;
    return node;
};

/* The children of a token, as the contiguous run of source they cover. Returned with where that run SITS inside
 * the parent's own source, which is how the parent's markers are found: everything before it opens the token,
 * everything after closes it. Derived by subtraction rather than by re-deriving the lexer's delimiter rules,
 * so a construct this file has never heard of still comes out with its markers in the right place. */
const innerSpan = (token: MarkdownToken): { readonly at: number; readonly text: string } | undefined => {
    const children = token.tokens;
    if (children === undefined || children.length === 0) {
        return undefined;
    }
    const text = children.map((child) => child.raw).join(``);
    if (text === ``) {
        return undefined;
    }
    /* Searched from 1, never 0: every token that HAS an opening marker has at least one character of it, and a
     * link whose text is also its target (`[a](a)`) would otherwise match at the destination instead of at the
     * label. A token whose children start at 0 (marked wraps some plain runs that way) is found by the fallback
     * search below rather than mis-anchored here. */
    const at = token.raw.indexOf(text, 1);
    return at === -1 ? (token.raw === text ? { at: 0, text } : undefined) : { at, text };
};

// The element an inline token is drawn as. `undefined` ⇒ its content is drawn without a wrapper of its own.
const inlineTag = (type: string): string | undefined =>
    ({ strong: `strong`, em: `em`, del: `del`, codespan: `code`, link: `a`, image: `span` })[type];

const appendInline = (parent: Node, tokens: readonly MarkdownToken[]): void => {
    for (const token of tokens) {
        const inner = innerSpan(token);
        const tag = inlineTag(token.type);
        // A leaf with no markup of its own (plain text, an escape, a raw-HTML run): its source IS its text.
        if (inner === undefined) {
            if (tag === undefined) {
                parent.appendChild(document.createTextNode(token.raw));
                /* A HARD BREAK is the one place a newline in this document really does break the line, so it is
                 * the one place an element is added that carries no source of its own. The `<br>` contributes
                 * nothing to `textContent`, so the invariant holds; the two trailing spaces (or the backslash)
                 * that asked for it stay in the text, where they can be deleted to take the break away. */
                if (token.type === `br`) {
                    parent.appendChild(document.createElement(`br`));
                }
                continue;
            }
            /* A codespan has no child tokens (its body is not markdown) but does have delimiters, so its
             * backticks are split off by length: the run of them that opens it is the run that closes it. */
            const ticks = /^`+/u.exec(token.raw)?.[0] ?? ``;
            const element = document.createElement(tag);
            element.appendChild(span(ticks, MARKER));
            element.appendChild(document.createTextNode(token.raw.slice(ticks.length, token.raw.length - ticks.length)));
            element.appendChild(span(ticks, MARKER));
            parent.appendChild(element);
            continue;
        }
        const element = tag === undefined ? parent : document.createElement(tag);
        if (element !== parent && element instanceof HTMLAnchorElement) {
            // Inert while editing: the href is in the source the user is looking at, and a click here places a
            // caret. The surface opens links from the PREVIEW rendering, which is the one you read.
            element.removeAttribute(`href`);
        }
        element.appendChild(span(token.raw.slice(0, inner.at), MARKER));
        appendInline(element, token.tokens ?? []);
        element.appendChild(span(token.raw.slice(inner.at + inner.text.length), MARKER));
        if (element !== parent) {
            parent.appendChild(element);
        }
    }
};

/* An empty marker span is markup that is not there (an unwrapped run's absent delimiters). Removing them keeps
 * the DOM honest about what the file contains and stops the caret finding places to sit that hold nothing. */
const dropEmptyMarkers = (root: HTMLElement): void => {
    for (const node of root.querySelectorAll(`.${MARKER}`)) {
        if (node.textContent === ``) {
            node.remove();
        }
    }
};

// Inline content, straight from the source text: every character of `text` ends up in the element.
const appendText = (parent: Node, text: string): void => {
    const tokens = lexInline(text);
    if (tokens === undefined) {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    appendInline(parent, tokens);
};

/* WHY LISTS AND QUOTES ARE BUILT FROM LINES, not from the token tree the way headings and paragraphs are.
 *
 * The block lexer RE-INDENTS the source of a nested construct: a nested list written with four spaces comes back
 * as a token whose raw carries two, because indentation is relative to the item it sits in. That is right for
 * rendering and fatal here, where the DOM has to account for every original character. Every nested list failed
 * the invariant and fell back to showing its source verbatim.
 *
 * Splitting the block's own text by line and taking each line's leading markup by position never loses a
 * character, because nothing is re-derived: the prefix is a slice, and the rest is a slice. It also collapses
 * four cases into one, ordered, unordered, task and nested items are all "a line with a marker in front of it",
 * and their indentation hangs in the gutter along with the bullet, which is what keeps the nesting columns lined
 * up whether or not the markers are showing. */
/* A task item's `[ ]` is part of the line's opening markup, not part of its words, so it hangs in the gutter
 * with the bullet. At rest the CSS draws a checkbox there instead, which is what the rendered document shows, so
 * the item's text sits at the same place whichever of the two is on screen. */
const LIST_LINE = /^(\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/su;
const TASK_LEAD = /\[([ xX])\][ \t]+$/u;
const QUOTE_LINE = /^(\s*>[ \t]?)(.*)$/su;
const HEADING_LINE = /^(#{1,6}[ \t]+)(.*)$/su;

// The block's lines, each keeping the newline that ends it, so joining them back gives the source unchanged.
const sourceLines = (source: string): string[] => source.split(/(?<=\n)/u);

/* A block whose lines are rows, and whose LINE ENDINGS are not in the DOM.
 *
 * A `\n` at the end of a row is whitespace at a line boundary, which a browser does not render and therefore
 * feels free to delete inside a `contenteditable`: typing at the end of a list item silently welded it to the
 * item below. (Whitespace BETWEEN words is rendered, as the space markdown turns a soft break into, and is safe;
 * this is only ever about the boundary.) So a rows block carries its structure in its shape instead, and
 * `blockBody` reads it back by joining the rows with the newlines that separate them. */
const ROWS = `mdRows`;

/** The source of one block, read back from the element that draws it. */
export const blockBody = (element: Element): string =>
    ROWS in (element as HTMLElement).dataset ? [...element.children].map((row) => row.textContent ?? ``).join(`\n`) : (element.textContent ?? ``);

const linePrefixed = (source: string, tag: string, lineTag: string, pattern: RegExp, className?: string): HTMLElement => {
    const element = document.createElement(tag);
    element.dataset[ROWS] = ``;
    if (className !== undefined) {
        element.className = className;
    }
    for (const line of sourceLines(source)) {
        const row = document.createElement(lineTag);
        const body = line.endsWith(`\n`) ? line.slice(0, -1) : line;
        const match = pattern.exec(body);
        if (match === null) {
            // A continuation line (the second line of a wrapped item, a loose item's own paragraph): no marker
            // of its own, so its leading whitespace is the indent and hangs like one.
            const indent = /^[ \t]*/u.exec(body)?.[0] ?? ``;
            element.appendChild(row);
            row.appendChild(span(indent, MARKER, GUTTER));
            appendText(row, body.slice(indent.length));
        } else {
            const lead = match[1] ?? ``;
            const task = TASK_LEAD.exec(lead);
            element.appendChild(row);
            if (task !== null) {
                // Read by the stylesheet, which draws the checkbox this markup stands for while the item is at
                // rest. `1`/`0` rather than the character, so the CSS does not have to know markdown.
                row.dataset[`task`] = (task[1] ?? ` `) === ` ` ? `0` : `1`;
            }
            row.appendChild(span(lead, MARKER, GUTTER));
            appendText(row, match[2] ?? ``);
        }
    }
    return element;
};

const headingElement = (source: string, depth: number): HTMLElement => {
    const element = document.createElement(`h${Math.min(6, Math.max(1, depth))}`);
    const match = HEADING_LINE.exec(source);
    element.appendChild(span(match?.[1] ?? ``, MARKER, GUTTER));
    appendText(element, match === null ? source : (match[2] ?? ``));
    return element;
};

const paragraphElement = (token: MarkdownToken, source: string): HTMLElement => {
    const element = document.createElement(`p`);
    const tokens = token.tokens;
    if (tokens === undefined || tokens.map((child) => child.raw).join(``) !== source) {
        appendText(element, source);
        return element;
    }
    appendInline(element, tokens);
    return element;
};

const listElement = (source: string, ordered: boolean): HTMLElement => linePrefixed(source, ordered ? `ol` : `ul`, `li`, LIST_LINE, `md-src-list`);

const quoteElement = (source: string): HTMLElement => linePrefixed(source, `blockquote`, `div`, QUOTE_LINE, `md-src-quote`);

/* Everything this file does not model as prose: a fenced block, a table, raw HTML, a rule. Its source is shown
 * verbatim in a box that keeps the shape the rendered form had, which for a code block is very nearly the same
 * picture (a code block already IS its source; only the fences appear). A table becomes its pipes, which is the
 * honest answer: there is no way to edit a rendered table's markdown except as markdown. */
const verbatimElement = (source: string, kind: string): HTMLElement => {
    const element = document.createElement(`pre`);
    element.className = kind === `code` ? `md-code-block md-src-verbatim` : `md-src-verbatim`;
    element.appendChild(document.createTextNode(source));
    return element;
};

const buildProse = (token: MarkdownToken, source: string): HTMLElement | undefined => {
    if (token.type === `heading`) {
        return headingElement(source, (token as MarkdownToken & { depth?: number }).depth ?? 1);
    }
    if (token.type === `paragraph`) {
        return paragraphElement(token, source);
    }
    if (token.type === `list`) {
        return listElement(source, (token as MarkdownToken & { ordered?: boolean }).ordered === true);
    }
    return token.type === `blockquote` ? quoteElement(source) : undefined;
};

/**
 * One block of markdown, as an element whose `textContent` is that block's source.
 *
 * `source` is the block's text WITHOUT the blank lines that separate it from the next (see `blockText`): those
 * are the document's structure, not the block's content, and the surface holds them separately.
 */
export const buildBlockElement = (source: string): HTMLElement => {
    const tokens = lexBlocks(source);
    const token = tokens?.length === 1 ? tokens[0] : undefined;
    const built = token === undefined ? undefined : buildProse(token, source);
    if (built !== undefined) {
        dropEmptyMarkers(built);
        // THE INVARIANT, checked rather than trusted. A block whose pieces do not reassemble its source is shown
        // as its source: less pretty, and still exactly the file.
        if (blockBody(built) === source) {
            return built;
        }
    }
    return verbatimElement(source, token?.type ?? `text`);
};

// Offsets within one run of text nodes, ignoring any row structure above them.
const textOffset = (root: Element, node: Node, offset: number): number => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        if (text === node) {
            return total + offset;
        }
        total += text.textContent?.length ?? 0;
    }
    /* The caret is on an ELEMENT rather than in text, which is what a browser reports for an empty line or the
     * boundary between two blocks. Its offset counts child nodes, so the answer is everything before it. */
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return range.toString().length;
};

const textCaret = (root: Element, offset: number): { readonly node: Node; readonly offset: number } | undefined => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let last: Text | undefined;
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        const length = text.textContent?.length ?? 0;
        if (offset <= total + length) {
            return { node: text, offset: offset - total };
        }
        total += length;
        last = text as Text;
    }
    return last === undefined ? { node: root, offset: 0 } : { node: last, offset: last.textContent?.length ?? 0 };
};

const rowsOf = (element: HTMLElement): Element[] | undefined => (ROWS in element.dataset ? [...element.children] : undefined);

/** The offset into a BLOCK's source that a caret sits at, given the node and offset a selection reports. */
export const offsetOfCaret = (element: HTMLElement, node: Node, offset: number): number => {
    const rows = rowsOf(element);
    if (rows === undefined) {
        return textOffset(element, node, offset);
    }
    // A caret reported on the BLOCK itself, which is what a browser gives for the seam between two rows: its
    // offset counts rows, not characters, so the answer is everything in the rows before it.
    const upTo = node === element ? offset : rows.length;
    // A row's own text, plus one for each line ending crossed to reach it. Those newlines are not in the DOM
    // (see `blockBody`), so they are counted here instead.
    let total = 0;
    for (const [index, row] of rows.entries()) {
        if (index >= upTo) {
            return total;
        }
        if (row === node || row.contains(node)) {
            return total + textOffset(row, node, offset);
        }
        total += (row.textContent ?? ``).length + (index < rows.length - 1 ? 1 : 0);
    }
    return total;
};

/** Where in a block's DOM a source offset sits, for putting the caret back after a re-render. */
export const caretAtOffset = (element: HTMLElement, offset: number): { readonly node: Node; readonly offset: number } | undefined => {
    const rows = rowsOf(element);
    if (rows === undefined) {
        return textCaret(element, offset);
    }
    let remaining = offset;
    for (const [index, row] of rows.entries()) {
        const length = (row.textContent ?? ``).length;
        if (remaining <= length || index === rows.length - 1) {
            return textCaret(row, Math.max(0, Math.min(remaining, length)));
        }
        remaining -= length + 1;
    }
    return undefined;
};
