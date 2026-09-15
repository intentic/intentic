import type { Block, Cell, Inline, Row } from "./document-model";
import type { Css, StyleBook } from "./styles";
import { attr, child, childElements, descendant, isElement, textOf, type XmlElement, type XmlNode } from "./xml-tree";

/* content.xml's flowing text, as blocks. Shared by every ODF viewer: a paragraph reads the same inside a document,
   a spreadsheet cell and a slide's text box. */

export interface Context {
    readonly styles: StyleBook;
    readonly image: (href: string) => string | undefined;
    /** Footnote and endnote bodies, collected as they are met and rendered after the text that cites them. */
    readonly notes: Block[];
}

const NBSP = ` `;
// Repeats big enough to be a generated run rather than authored content; past these a file is padding, not text.
const MAX_REPEAT = 64;
const MAX_SPACES = 200;

const styleOf = (context: Context, name: string | undefined, family: string) =>
    name === undefined ? context.styles.fallback(family) : context.styles.style(name);

const spanned = (element: XmlElement, name: string, fallback: number): number => {
    const value = Number.parseInt(attr(element, name) ?? ``, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_REPEAT) : fallback;
};

type InlineHandler = (element: XmlElement, css: Css, context: Context, out: Inline[]) => void;

interface Picture {
    readonly src: string;
    readonly alt: string;
    readonly css: Css;
}

// A frame's own picture is its direct child; a picture deeper inside belongs to whatever contains it.
const frameImage = (element: XmlElement, context: Context): Picture | undefined => {
    const href = attr(child(element, `draw:image`), `xlink:href`);
    const src = href === undefined ? undefined : context.image(href);
    if (src === undefined) {
        return undefined;
    }
    const title = child(element, `svg:title`) ?? child(element, `svg:desc`);
    const width = attr(element, `svg:width`);
    const height = attr(element, `svg:height`);
    const css: Record<string, string> = { "max-width": `100%` };
    if (width !== undefined) {
        css[`width`] = width;
    }
    if (height !== undefined) {
        css[`height`] = height;
    }
    return { src, alt: title === undefined ? `` : textOf(title), css };
};

const INLINES: Readonly<Record<string, InlineHandler>> = {
    "text:span": (element, css, context, out) => {
        const merged = { ...css, ...styleOf(context, attr(element, `text:style-name`), `text`).text };
        out.push(...inlinesOf(element, merged, context));
    },
    "text:a": (element, css, context, out) => {
        const href = attr(element, `xlink:href`) ?? ``;
        out.push({ kind: `link`, href, inlines: inlinesOf(element, css, context) });
    },
    "text:s": (element, css, _context, out) => {
        const count = Number.parseInt(attr(element, `text:c`) ?? `1`, 10);
        // Non-breaking, because HTML collapses a run of ordinary spaces and ODF wrote this run deliberately.
        out.push({ kind: `text`, text: NBSP.repeat(Math.min(Number.isFinite(count) && count > 0 ? count : 1, MAX_SPACES)), css });
    },
    "text:tab": (_element, _css, _context, out) => out.push({ kind: `tab` }),
    "text:line-break": (_element, _css, _context, out) => out.push({ kind: `break` }),
    "draw:frame": (element, _css, context, out) => {
        const image = frameImage(element, context);
        if (image !== undefined) {
            out.push({ kind: `image`, ...image });
        }
    },
    "text:note": (element, css, context, out) => {
        const citation = descendant(element, `text:note-citation`);
        const mark = citation === undefined ? `*` : textOf(citation);
        out.push({ kind: `text`, text: mark, css: { ...css, "vertical-align": `super`, "font-size": `0.7em` } });
        const body = descendant(element, `text:note-body`);
        if (body !== undefined) {
            context.notes.push(...blocksOf(body, context, `${mark} `));
        }
    },
    // Comments and tracked changes are not what the page says, so they are not shown as if they were.
    "office:annotation": () => {},
    "office:annotation-end": () => {},
    "text:tracked-changes": () => {},
    "text:soft-page-break": () => {},
};

/** A paragraph's children as inlines. An unknown element contributes its text, so nothing is silently dropped. */
export const inlinesOf = (element: XmlElement, css: Css, context: Context): Inline[] => {
    const out: Inline[] = [];
    for (const node of element.children) {
        if (!isElement(node)) {
            out.push({ kind: `text`, text: node.text, css });
            continue;
        }
        const handler = INLINES[node.tag];
        if (handler === undefined) {
            out.push(...inlinesOf(node, css, context));
            continue;
        }
        handler(node, css, context, out);
    }
    return out;
};

const HEADING_TAG = `text:h`;

const paragraphOf = (element: XmlElement, context: Context, prefix?: string): Block => {
    const style = styleOf(context, attr(element, `text:style-name`), `paragraph`);
    const inlines = inlinesOf(element, style.text, context);
    const level = element.tag === HEADING_TAG ? Math.min(6, Math.max(1, Number.parseInt(attr(element, `text:outline-level`) ?? `1`, 10) || 1)) : 0;
    return {
        kind: `paragraph`,
        level,
        css: style.block,
        inlines: prefix === undefined ? inlines : [{ kind: `text`, text: prefix, css: style.text }, ...inlines],
    };
};

const listOf = (element: XmlElement, context: Context, depth: number, inherited: string | undefined): Block => {
    const name = attr(element, `text:style-name`) ?? inherited;
    const level = context.styles.list(name, depth);
    const items = childElements(element)
        .filter((item) => item.tag === `text:list-item` || item.tag === `text:list-header`)
        .map((item) => blocksOf(item, context, undefined, depth + 1, name));
    return { kind: `list`, ordered: level.ordered, type: level.type, start: level.start, items };
};

const cellOf = (element: XmlElement, context: Context): Cell => ({
    blocks: blocksOf(element, context),
    css: styleOf(context, attr(element, `table:style-name`), `table-cell`).block,
    colspan: spanned(element, `table:number-columns-spanned`, 1),
    rowspan: spanned(element, `table:number-rows-spanned`, 1),
});

const rowOf = (element: XmlElement, context: Context, header: boolean): Row => {
    const cells: Cell[] = [];
    for (const item of childElements(element)) {
        if (item.tag !== `table:table-cell`) {
            // A covered cell is the hole a span already fills; anything else in a row is not a cell.
            continue;
        }
        const cell = cellOf(item, context);
        for (let repeat = 0; repeat < spanned(item, `table:number-columns-repeated`, 1); repeat += 1) {
            cells.push(cell);
        }
    }
    return { cells, css: styleOf(context, attr(element, `table:style-name`), `table-row`).block, header };
};

const rowsOf = (element: XmlElement, context: Context, header: boolean, into: Row[]): void => {
    for (const item of childElements(element)) {
        if (item.tag === `table:table-row`) {
            const row = rowOf(item, context, header);
            for (let repeat = 0; repeat < spanned(item, `table:number-rows-repeated`, 1); repeat += 1) {
                into.push(row);
            }
            continue;
        }
        if (item.tag === `table:table-header-rows`) {
            rowsOf(item, context, true, into);
            continue;
        }
        if (item.tag === `table:table-rows` || item.tag === `table:table-row-group`) {
            rowsOf(item, context, header, into);
        }
    }
};

// Columns are grouped as freely as rows are: a writer may wrap them in <table:table-columns> or a column group.
const columnsOf = (element: XmlElement, context: Context, into: string[]): void => {
    for (const item of childElements(element)) {
        if (item.tag === `table:table-column`) {
            const width = context.styles.style(attr(item, `table:style-name`)).columnWidth ?? `auto`;
            for (let repeat = 0; repeat < spanned(item, `table:number-columns-repeated`, 1); repeat += 1) {
                into.push(width);
            }
            continue;
        }
        if (item.tag === `table:table-columns` || item.tag === `table:table-header-columns` || item.tag === `table:table-column-group`) {
            columnsOf(item, context, into);
        }
    }
};

const tableOf = (element: XmlElement, context: Context): Block => {
    const columns: string[] = [];
    columnsOf(element, context, columns);
    const rows: Row[] = [];
    rowsOf(element, context, false, rows);
    return { kind: `table`, columns, rows, css: styleOf(context, attr(element, `table:style-name`), `table`).block };
};

// A frame is either a picture or a box of text; where it carries both, the text is the content and the picture is
// the writer's fallback rendering of it.
const frameBlock = (element: XmlElement, context: Context): Block | undefined => {
    const box = descendant(element, `draw:text-box`);
    const blocks = box === undefined ? blocksOf(element, context) : blocksOf(box, context);
    if (blocks.length > 0) {
        return { kind: `box`, css: styleOf(context, attr(element, `draw:style-name`), `graphic`).block, blocks };
    }
    const image = frameImage(element, context);
    return image === undefined ? undefined : { kind: `image`, ...image };
};

type BlockHandler = (element: XmlElement, context: Context, out: Block[], depth: number, listStyle: string | undefined) => void;

const BLOCKS: Readonly<Record<string, BlockHandler>> = {
    "text:p": (element, context, out) => out.push(paragraphOf(element, context)),
    [HEADING_TAG]: (element, context, out) => out.push(paragraphOf(element, context)),
    "text:list": (element, context, out, depth, listStyle) => out.push(listOf(element, context, depth, listStyle)),
    "table:table": (element, context, out) => out.push(tableOf(element, context)),
    "draw:frame": (element, context, out) => {
        const block = frameBlock(element, context);
        if (block !== undefined) {
            out.push(block);
        }
    },
    // Wrappers that hold ordinary text: read through them rather than past them.
    "text:section": (element, context, out, depth, listStyle) => out.push(...blocksOf(element, context, undefined, depth, listStyle)),
    "text:index-body": (element, context, out, depth, listStyle) => out.push(...blocksOf(element, context, undefined, depth, listStyle)),
    "text:table-of-content": (element, context, out, depth, listStyle) => out.push(...blocksOf(element, context, undefined, depth, listStyle)),
    "text:illustration-index": (element, context, out, depth, listStyle) => out.push(...blocksOf(element, context, undefined, depth, listStyle)),
    "text:alphabetical-index": (element, context, out, depth, listStyle) => out.push(...blocksOf(element, context, undefined, depth, listStyle)),
    "office:annotation": () => {},
    "text:tracked-changes": () => {},
    "text:sequence-decls": () => {},
    "text:variable-decls": () => {},
    "text:user-field-decls": () => {},
    "text:index-title-template": () => {},
};

/** One element as blocks, appended to `out`; an element this renderer has no handler for contributes nothing. */
export const appendBlock = (element: XmlElement, context: Context, out: Block[], depth = 0, listStyle?: string): void =>
    BLOCKS[element.tag]?.(element, context, out, depth, listStyle);

/**
 * An element's children as blocks. `prefix` labels the first paragraph (a footnote's marker); `depth` and `listStyle`
 * carry a nested list's level and the style it inherits.
 */
export const blocksOf = (element: XmlElement, context: Context, prefix?: string, depth = 0, listStyle?: string): Block[] => {
    const out: Block[] = [];
    for (const item of childElements(element)) {
        appendBlock(item, context, out, depth, listStyle);
    }
    if (prefix !== undefined && out[0]?.kind === `paragraph`) {
        out[0] = { ...out[0], inlines: [{ kind: `text`, text: prefix, css: {} }, ...out[0].inlines] };
    }
    return out;
};

/** Whether this node ends a page: ODF marks where a printed copy would break. */
export const isPageBreak = (node: XmlNode, context: Context): boolean => {
    if (!isElement(node)) {
        return false;
    }
    return node.tag === `text:soft-page-break` || styleOf(context, attr(node, `text:style-name`), `paragraph`).pageBreak;
};
