import { lexBlocks, lexInline, type MarkdownToken } from "./render.js";

// This block's DOM text is its markdown source, byte for byte (`blockBody(element) === source`), so
// `contenteditable` edits the source directly; markers sit in text nodes wrapped in spans CSS can hide. Line-end
// newlines are the exception: the browser drops them, so they live in the block's shape (one row per line) and
// `blockBody` restores them. A builder that can't reassemble its source exactly falls back to one plain text node
// holding it verbatim.

// Markup, as opposed to words: hidden while the block is at rest, revealed when the caret is in it.
const MARKER = `md-marker`;
// The leading markup of a line (`## `, `- `, `> `), which hangs in the gutter so revealing it never moves the text
// after it.
const GUTTER = `md-marker-gutter`;

const span = (text: string, ...classes: string[]): HTMLSpanElement => {
    const node = document.createElement(`span`);
    node.className = classes.join(` `);
    node.textContent = text;
    return node;
};

// Where a token's children sit in its own source, so the parent's markers are found by subtraction rather than by
// re-deriving the lexer's delimiter rules.
const innerSpan = (token: MarkdownToken): { readonly at: number; readonly text: string } | undefined => {
    const children = token.tokens;
    if (children === undefined || children.length === 0) {
        return undefined;
    }
    const text = children.map((child) => child.raw).join(``);
    if (text === ``) {
        return undefined;
    }
    // Searched from 1, not 0, so a link whose text equals its target (`[a](a)`) matches its label, not its destination.
    const at = token.raw.indexOf(text, 1);
    return at === -1 ? (token.raw === text ? { at: 0, text } : undefined) : { at, text };
};

// The element an inline token draws as; undefined means its content gets no wrapper of its own.
const inlineTag = (type: string): string | undefined =>
    ({ strong: `strong`, em: `em`, del: `del`, codespan: `code`, link: `a`, image: `span` })[type];

// A leaf with no markup of its own; its source is its text. Split from the tokens-with-children walk so each
// function has one job.
const appendLeaf = (parent: Node, token: MarkdownToken, tag: string | undefined): void => {
    if (tag === undefined) {
        parent.appendChild(document.createTextNode(token.raw));
        // A hard break: added with no text of its own so the invariant holds; the markup that requested it stays in the
        // text.
        if (token.type === `br`) {
            parent.appendChild(document.createElement(`br`));
        }
        return;
    }
    // A codespan has no child tokens but has delimiters; the backtick run that opens it is the run that closes it.
    const ticks = /^`+/u.exec(token.raw)?.[0] ?? ``;
    const element = document.createElement(tag);
    element.appendChild(span(ticks, MARKER));
    element.appendChild(document.createTextNode(token.raw.slice(ticks.length, token.raw.length - ticks.length)));
    element.appendChild(span(ticks, MARKER));
    parent.appendChild(element);
};

const appendInline = (parent: Node, tokens: readonly MarkdownToken[]): void => {
    for (const token of tokens) {
        const inner = innerSpan(token);
        const tag = inlineTag(token.type);
        if (inner === undefined) {
            appendLeaf(parent, token, tag);
            continue;
        }
        const element = tag === undefined ? parent : document.createElement(tag);
        if (element !== parent && element instanceof HTMLAnchorElement) {
            // Inert while editing: a click here places a caret. Links open from the preview rendering instead.
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

// An empty marker span is markup that isn't there. Removed so the DOM stays honest about the file's contents and
// the caret has nowhere empty to land.
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

// Lists/quotes are built by line, not from the token tree: the block lexer re-indents nested source, so the tree
// doesn't preserve every original character. Splitting each line by its leading markup is lossless (pure slices)
// and treats ordered, unordered, task, and nested items alike, with indentation in the gutter to keep nesting
// aligned.
// A task item's `[ ]` is part of the line's opening markup, not its words, so it hangs in the gutter with the
// bullet; CSS draws a checkbox there at rest.
const LIST_LINE = /^(\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(.*)$/su;
const TASK_LEAD = /\[([ xX])\][ \t]+$/u;
const QUOTE_LINE = /^(\s*>[ \t]?)(.*)$/su;
const HEADING_LINE = /^(#{1,6}[ \t]+)(.*)$/su;

// The block's lines, each keeping the newline that ends it, so joining them back gives the source unchanged.
const sourceLines = (source: string): string[] => source.split(/(?<=\n)/u);

// Line endings live in the block's shape, not its DOM text: a trailing newline is boundary whitespace a browser
// won't render, and `contenteditable` deletes what it can't render. `blockBody` restores them by joining rows with
// newlines.
const ROWS = `mdRows`;

/** The source of one block, read back from the element that draws it. */
export const blockBody = (element: Element): string =>
    ROWS in (element as HTMLElement).dataset ? [...element.children].map((row) => row.textContent ?? ``).join(`\n`) : (element.textContent ?? ``);

/** One row of a line-prefixed block: its opening marker into the gutter, the rest of the line as text. */
const appendPrefixedRow = (row: HTMLElement, body: string, pattern: RegExp): void => {
    const match = pattern.exec(body);
    if (match === null) {
        // A continuation line has no marker of its own; its leading whitespace is the indent and hangs like one.
        const indent = /^[ \t]*/u.exec(body)?.[0] ?? ``;
        row.appendChild(span(indent, MARKER, GUTTER));
        appendText(row, body.slice(indent.length));
        return;
    }
    const lead = match[1] ?? ``;
    const task = TASK_LEAD.exec(lead);
    if (task !== null) {
        // Read by the stylesheet to draw the checkbox at rest; `1`/`0` rather than the character, so CSS need not know
        // markdown.
        row.dataset[`task`] = (task[1] ?? ` `) === ` ` ? `0` : `1`;
    }
    row.appendChild(span(lead, MARKER, GUTTER));
    appendText(row, match[2] ?? ``);
};

const linePrefixed = (source: string, tag: string, lineTag: string, pattern: RegExp, className?: string): HTMLElement => {
    const element = document.createElement(tag);
    element.dataset[ROWS] = ``;
    if (className !== undefined) {
        element.className = className;
    }
    for (const line of sourceLines(source)) {
        const row = document.createElement(lineTag);
        element.appendChild(row);
        appendPrefixedRow(row, line.endsWith(`\n`) ? line.slice(0, -1) : line, pattern);
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

// Anything not modeled as prose (fenced block, table, raw HTML, a rule): shown verbatim, since there is no way to
// edit a rendered table or code block except as its markdown.
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
 * One block of markdown as an element whose `textContent` is that block's source. `source` excludes the blank
 * lines separating it from the next block; those are document structure, held separately by the surface.
 */
export const buildBlockElement = (source: string): HTMLElement => {
    const tokens = lexBlocks(source);
    const token = tokens?.length === 1 ? tokens[0] : undefined;
    const built = token === undefined ? undefined : buildProse(token, source);
    if (built !== undefined) {
        dropEmptyMarkers(built);
        // The invariant, checked rather than trusted: a block that doesn't reassemble its source exactly is shown as
        // source instead.
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
    // Caret is on an element, not text (what the browser reports for an empty line or block boundary); its offset
    // counts child nodes.
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

/** The offset into a block's source that a caret sits at, given the node/offset a selection reports. */
export const offsetOfCaret = (element: HTMLElement, node: Node, offset: number): number => {
    const rows = rowsOf(element);
    if (rows === undefined) {
        return textOffset(element, node, offset);
    }
    // Caret on the block itself is the seam between two rows; its offset counts rows, not characters.
    const upTo = node === element ? offset : rows.length;
    // A row's text plus one per line ending crossed to reach it; those newlines aren't in the DOM (see `blockBody`).
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
