import type { Block, Cell, Inline, Row } from "./document-model";
import type { Css } from "./styles";

/* Blocks into DOM. Every node is built with createElement and textContent — no HTML is ever assembled as a string,
   so nothing a document carries can become markup here. */

const SAFE_PROTOCOL = /^(https?:|mailto:|tel:)/i;

const apply = (element: HTMLElement, css: Css): void => {
    for (const [property, value] of Object.entries(css)) {
        element.style.setProperty(property, value);
    }
};

const inlineNode = (inline: Inline, document: Document): Node => {
    switch (inline.kind) {
        case `text`: {
            if (Object.keys(inline.css).length === 0) {
                return document.createTextNode(inline.text);
            }
            const span = document.createElement(`span`);
            apply(span, inline.css);
            span.textContent = inline.text;
            return span;
        }
        case `break`:
            return document.createElement(`br`);
        case `tab`: {
            const tab = document.createElement(`span`);
            tab.style.whiteSpace = `pre`;
            tab.style.tabSize = `4`;
            tab.textContent = `\t`;
            return tab;
        }
        case `link`: {
            const anchor = document.createElement(`a`);
            // A document's own link text is shown whatever the target is; only a safe target becomes clickable.
            if (SAFE_PROTOCOL.test(inline.href)) {
                anchor.href = inline.href;
                anchor.target = `_blank`;
                anchor.rel = `noreferrer noopener`;
            }
            for (const child of inline.inlines) {
                anchor.append(inlineNode(child, document));
            }
            return anchor;
        }
        default: {
            const image = document.createElement(`img`);
            image.src = inline.src;
            image.alt = inline.alt;
            image.loading = `lazy`;
            apply(image, inline.css);
            return image;
        }
    }
};

const cellNode = (cell: Cell, header: boolean, document: Document): HTMLElement => {
    const node = document.createElement(header ? `th` : `td`);
    if (cell.colspan > 1) {
        node.colSpan = cell.colspan;
    }
    if (cell.rowspan > 1) {
        node.rowSpan = cell.rowspan;
    }
    apply(node, cell.css);
    renderBlocks(cell.blocks, node, document);
    return node;
};

const rowNode = (row: Row, document: Document): HTMLElement => {
    const node = document.createElement(`tr`);
    apply(node, row.css);
    for (const cell of row.cells) {
        node.append(cellNode(cell, row.header, document));
    }
    return node;
};

const tableNode = (block: Extract<Block, { kind: "table" }>, document: Document): HTMLElement => {
    const table = document.createElement(`table`);
    apply(table, block.css);
    if (block.columns.length > 0) {
        const group = document.createElement(`colgroup`);
        for (const width of block.columns) {
            const column = document.createElement(`col`);
            column.style.width = width;
            group.append(column);
        }
        table.append(group);
    }
    const head = document.createElement(`thead`);
    const body = document.createElement(`tbody`);
    for (const row of block.rows) {
        (row.header ? head : body).append(rowNode(row, document));
    }
    if (head.childElementCount > 0) {
        table.append(head);
    }
    table.append(body);
    return table;
};

const listNode = (block: Extract<Block, { kind: "list" }>, document: Document): HTMLElement => {
    const list = document.createElement(block.ordered ? `ol` : `ul`);
    list.style.listStyleType = block.type;
    if (block.ordered && block.start !== undefined && block.start !== 1) {
        list.setAttribute(`start`, String(block.start));
    }
    for (const item of block.items) {
        const entry = document.createElement(`li`);
        renderBlocks(item, entry, document);
        list.append(entry);
    }
    return list;
};

const paragraphNode = (block: Extract<Block, { kind: "paragraph" }>, document: Document): HTMLElement => {
    const node = document.createElement(block.level === 0 ? `p` : `h${block.level}`);
    apply(node, block.css);
    for (const inline of block.inlines) {
        node.append(inlineNode(inline, document));
    }
    // An empty paragraph is deliberate spacing in a document; without something in it, the line would collapse.
    if (node.childNodes.length === 0) {
        node.append(document.createElement(`br`));
    }
    return node;
};

const blockNode = (block: Block, document: Document): HTMLElement => {
    switch (block.kind) {
        case `paragraph`:
            return paragraphNode(block, document);
        case `list`:
            return listNode(block, document);
        case `table`:
            return tableNode(block, document);
        case `image`: {
            const figure = document.createElement(`div`);
            figure.append(inlineNode({ kind: `image`, src: block.src, alt: block.alt, css: block.css }, document));
            return figure;
        }
        default: {
            const box = document.createElement(`div`);
            apply(box, block.css);
            renderBlocks(block.blocks, box, document);
            return box;
        }
    }
};

/** Renders blocks into `host`, appending to whatever is already there. */
export const renderBlocks = (blocks: readonly Block[], host: HTMLElement, document: Document): void => {
    for (const block of blocks) {
        host.append(blockNode(block, document));
    }
};
