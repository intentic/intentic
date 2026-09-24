import { highlightedCode } from "./code.js";
import { MERMAID_LANG } from "./figures.js";
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

// Inline content, straight from the source text: every character of `text` ends up in the element. Checked here
// rather than left to the block's own invariant, so one cell the inline lexer does not round-trip costs that cell
// its markup instead of costing the whole block its shape.
const appendText = (parent: Node, text: string): void => {
    const tokens = lexInline(text);
    if (tokens === undefined || tokens.map((token) => token.raw).join(``) !== text) {
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
// Marks an element that stands for one source line. Marked rather than counted as a child, so a wrapper a browser
// inserts of its own accord (a `tbody` inside a table) cannot silently rewrite the block's text.
const ROW = `mdRow`;

const rowElement = (tag: string, className?: string): HTMLElement => {
    const element = document.createElement(tag);
    element.dataset[ROW] = ``;
    if (className !== undefined) {
        element.className = className;
    }
    return element;
};

const rowsOf = (element: HTMLElement): Element[] | undefined => (ROWS in element.dataset ? [...element.querySelectorAll(`[data-md-row]`)] : undefined);

/** The source of one block, read back from the element that draws it. */
export const blockBody = (element: Element): string => {
    const rows = rowsOf(element as HTMLElement);
    return rows === undefined ? (element.textContent ?? ``) : rows.map((line) => line.textContent ?? ``).join(`\n`);
};

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
        const row = rowElement(lineTag);
        element.appendChild(row);
        appendPrefixedRow(row, line.endsWith(`\n`) ? line.slice(0, -1) : line, pattern);
    }
    return element;
};

// Every line of a block, without the newline that ends it: that lives in the block's shape (see `blockBody`).
const bodyLines = (source: string): string[] => sourceLines(source).map((line) => (line.endsWith(`\n`) ? line.slice(0, -1) : line));

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

// Anything not modeled as prose (an indented code block, a table, raw HTML, a rule): shown verbatim, since there
// is no way to edit a rendered table except as its markdown.
const verbatimElement = (source: string): HTMLElement => {
    const element = document.createElement(`pre`);
    element.className = `md-src-verbatim`;
    element.appendChild(document.createTextNode(source));
    return element;
};

// A fence line: three or more backticks or tildes, up to three spaces in. `rest` is the info string on an opener
// and must be blank on the closer.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/su;

const fenceOf = (line: string): { readonly marker: string; readonly rest: string } | undefined => {
    const match = FENCE.exec(line);
    return match?.[1] === undefined ? undefined : { marker: match[1], rest: match[2] ?? `` };
};

// One row of the fence itself: markup, so it collapses to nothing while the block is at rest and takes its line
// back the moment the caret is in the block.
const fenceRow = (source: string): HTMLElement => {
    const row = rowElement(`div`, `md-code-fence`);
    row.appendChild(span(source, MARKER));
    return row;
};

// Shiki's markup for the body, one element per line, or undefined while the highlight is still on its way. Parsed
// rather than sanitized: this is the highlighter's own output, the same markup the rendered document takes as raw
// HTML. A block that doesn't reassemble line for line stays plain, since the DOM's text is the file's text.
const colouredLines = (body: readonly string[], info: string): Element[] | undefined => {
    const html = highlightedCode(body.join(`\n`), info);
    if (html === undefined) {
        return undefined;
    }
    const holder = document.createElement(`div`);
    holder.innerHTML = html;
    const lines = [...holder.querySelectorAll(`.line`)];
    return lines.length === body.length && lines.every((line, at) => line.textContent === body[at]) ? lines : undefined;
};

const codeRow = (source: string, coloured: Element | undefined): HTMLElement => {
    const row = rowElement(`div`, `md-code-line`);
    row.append(...(coloured === undefined ? [document.createTextNode(source)] : coloured.childNodes));
    return row;
};

// A closer repeats the opener's character at least as many times, with nothing after it.
const closesFence = (line: string, marker: string): boolean => {
    const fence = fenceOf(line);
    return fence !== undefined && fence.rest.trim() === `` && fence.marker[0] === marker[0] && fence.marker.length >= marker.length;
};

// A fenced block's parts: the delimiter lines, the info string that names the language, and the code between.
interface FencedCode {
    readonly open: string;
    readonly info: string;
    readonly body: readonly string[];
    // Absent while the block is still being typed, which is most of the time it is edited.
    readonly close: string | undefined;
}

const fencedCode = (source: string): FencedCode | undefined => {
    const lines = bodyLines(source);
    const first = lines[0] ?? ``;
    const open = fenceOf(first);
    if (open === undefined) {
        return undefined;
    }
    const last = lines.at(-1) ?? ``;
    const closed = lines.length > 1 && closesFence(last, open.marker);
    return { open: first, info: open.rest, body: lines.slice(1, closed ? -1 : undefined), close: closed ? last : undefined };
};

// Where a closed ```mermaid block's diagram is drawn (by the surface, figureDrawing.ts): not a row, so it is no part of
// the block's text, and not editable, so the caret cannot land inside the picture.
export const FIGURE_HOLDER = `md-code-figure`;

const figureHolder = (code: string): HTMLElement => {
    const holder = document.createElement(`div`);
    holder.className = FIGURE_HOLDER;
    holder.setAttribute(`contenteditable`, `false`);
    holder.dataset[`mdFigureCode`] = code;
    return holder;
};

// A fenced block drawn as the code it holds: the fences are markup, like a heading's hashes, and the body wears
// the colours the rendered document gives it. Undefined for an indented code block, which has no fences to draw
// and whose indentation is part of its source.
const codeElement = (source: string): HTMLElement | undefined => {
    const fenced = fencedCode(source);
    if (fenced === undefined) {
        return undefined;
    }
    const coloured = colouredLines(fenced.body, fenced.info);
    const element = document.createElement(`pre`);
    element.className = `md-code-block`;
    element.dataset[ROWS] = ``;
    // Read by the stylesheet, which prints it where the rendered document prints its language chip.
    const lang = fenced.info.trim().split(/\s/u)[0] ?? ``;
    if (lang !== ``) {
        element.dataset[`mdLang`] = lang;
    }
    // Says this block has nothing more to gain from the highlighter, so a later batch leaves it alone.
    if (coloured !== undefined) {
        element.dataset[`mdColoured`] = ``;
    }
    element.appendChild(fenceRow(fenced.open));
    for (const [at, line] of fenced.body.entries()) {
        element.appendChild(codeRow(line, coloured?.[at]));
    }
    if (fenced.close !== undefined) {
        element.appendChild(fenceRow(fenced.close));
        if (lang === MERMAID_LANG) {
            element.appendChild(figureHolder(fenced.body.join(`\n`)));
        }
    }
    return element;
};

// A thematic break's three characters are markup, and what they draw is a line: the stylesheet draws it at rest
// and stands it down for the source when the caret arrives, the way a task box does.
const ruleElement = (source: string): HTMLElement => {
    const element = document.createElement(`div`);
    element.className = `md-src-rule`;
    element.appendChild(span(source, MARKER));
    return element;
};

// One table row split at its unescaped pipes: `lead` is the pipe that opens the cell, `trail` the one that closes
// the row. `lead + text + trail` over the row's cells is the source line, character for character.
interface TableCell {
    lead: string;
    text: string;
    trail: string;
}

// A backslash escapes the character after it (`\|` is a pipe in a cell, not a cell boundary), so both are carried
// across together.
const splitOnPipes = (line: string): { pipe: string; text: string }[] => {
    const parts: { pipe: string; text: string }[] = [];
    let pipe = ``;
    let text = ``;
    for (let at = 0; at < line.length; at += 1) {
        const char = line[at] ?? ``;
        if (char === `\\`) {
            text += char + (line[at + 1] ?? ``);
            at += 1;
            continue;
        }
        if (char !== `|`) {
            text += char;
            continue;
        }
        parts.push({ pipe, text });
        pipe = char;
        text = ``;
    }
    parts.push({ pipe, text });
    return parts;
};

// The row's cells. A row written the usual way opens and closes with a pipe, so the blank runs outside those two
// belong to the cells beside them rather than being cells of their own; a row written without them has neither.
const tableCells = (line: string): TableCell[] => {
    const cells: TableCell[] = splitOnPipes(line).map((part) => ({ lead: part.pipe, text: part.text, trail: `` }));
    const opening = cells[0];
    const first = cells[1];
    if (opening !== undefined && first !== undefined && opening.text.trim() === ``) {
        cells.shift();
        first.lead = `${opening.text}${first.lead}`;
    }
    const closing = cells.at(-1);
    const last = cells.at(-2);
    if (closing !== undefined && last !== undefined && closing.text.trim() === ``) {
        cells.pop();
        last.trail = `${closing.lead}${closing.text}`;
    }
    return cells;
};

// The row under the header, which is what makes a table a table: dashes, and a colon for a column that reads
// right or centred.
const ALIGN_CELL = /^\s*:?-+:?\s*$/u;

const isAlignRow = (line: string): boolean => {
    const cells = tableCells(line);
    return cells.length > 0 && cells.every((cell) => ALIGN_CELL.test(cell.text));
};

// Undefined for a plain run of dashes: the column then reads whichever way the stylesheet's default says, rather
// than carrying an attribute the markdown never wrote.
const alignOf = (cell: string): string | undefined => {
    const spec = cell.trim();
    const left = spec.startsWith(`:`);
    const right = spec.endsWith(`:`);
    if (left && right) {
        return `center`;
    }
    return right ? `right` : left ? `left` : undefined;
};

const tableRow = (line: string, tag: string, aligns: readonly (string | undefined)[]): HTMLElement => {
    const row = rowElement(`tr`);
    tableCells(line).forEach((cell, index) => {
        const element = document.createElement(tag);
        const align = aligns[index];
        if (align !== undefined) {
            element.setAttribute(`align`, align);
        }
        element.appendChild(span(cell.lead, MARKER));
        appendText(element, cell.text);
        element.appendChild(span(cell.trail, MARKER));
        row.appendChild(element);
    });
    return row;
};

// The alignment row is markup end to end, so every cell of it is one marker: at rest it draws as the rule under
// the header, which is what it means.
const alignRow = (line: string): HTMLElement => {
    const row = rowElement(`tr`, `md-src-align`);
    for (const cell of tableCells(line)) {
        const element = document.createElement(`td`);
        element.appendChild(span(`${cell.lead}${cell.text}${cell.trail}`, MARKER));
        row.appendChild(element);
    }
    return row;
};

// A table drawn as a table, its pipes markers like any other markup. Built from the source lines rather than the
// token's cells, which have already been trimmed and padded to a rectangle; undefined for anything without the
// alignment row, which is then shown as its source.
const tableElement = (source: string): HTMLElement | undefined => {
    const lines = bodyLines(source);
    const divider = lines[1];
    if (divider === undefined || !isAlignRow(divider)) {
        return undefined;
    }
    const aligns = tableCells(divider).map((cell) => alignOf(cell.text));
    const element = document.createElement(`table`);
    element.className = `md-src-table`;
    element.dataset[ROWS] = ``;
    lines.forEach((line, index) => {
        element.appendChild(index === 1 ? alignRow(line) : tableRow(line, index === 0 ? `th` : `td`, aligns));
    });
    return element;
};

// Every block shape this surface draws as itself; anything absent is shown as its own source (`verbatimElement`).
const BUILDERS: Record<string, (token: MarkdownToken, source: string) => HTMLElement | undefined> = {
    heading: (token, source) => headingElement(source, (token as MarkdownToken & { depth?: number }).depth ?? 1),
    paragraph: paragraphElement,
    list: (token, source) => listElement(source, (token as MarkdownToken & { ordered?: boolean }).ordered === true),
    blockquote: (_token, source) => quoteElement(source),
    code: (_token, source) => codeElement(source),
    table: (_token, source) => tableElement(source),
    hr: (_token, source) => ruleElement(source),
};

const buildProse = (token: MarkdownToken, source: string): HTMLElement | undefined => BUILDERS[token.type]?.(token, source);

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
    return verbatimElement(source);
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
