import { diffSequence, pairEdits, type Segment, similarity, wordDiff } from "@intentic/extension-ui/diff";

// Two parsed Word documents as one, the words that moved marked in place: the new document's body with what was
// removed struck through where it stood and what was added underlined, computed over docx-preview's own model
// between its parse and its render. Paragraphs (and a table's rows, then its cells' paragraphs) are matched by text,
// a paragraph matched to an edited self is split at the words, and the marks are the model's own revision wrappers,
// which `renderChanges` draws as <ins> and <del>. Pure: the nodes given are never mutated, the ones returned are new
// where they differ and the originals where they do not.

// The slice of docx-preview's model this reads and writes. Every node has a `type`; the rest is per type.
export interface DocxNode {
    readonly type: string;
    readonly children?: readonly DocxNode[];
    readonly text?: string;
    readonly className?: string;
    // A paragraph carrying a w:sectPr ends a section; a struck paragraph from the old document must not.
    readonly sectionProps?: unknown;
    readonly styleName?: string;
    readonly fieldRun?: boolean;
    readonly break?: string;
    readonly [key: string]: unknown;
}

export type RedlineKind = "changed" | "added" | "removed";

// One thing that happened, at the granularity a reader steps through: a paragraph edited, added or removed, or a
// table row (or whole table) added or removed. Every paragraph it touches carries `docx-redline-e<id>`.
export interface RedlineEvent {
    readonly id: number;
    readonly kind: RedlineKind;
}

export interface Redline {
    readonly children: readonly DocxNode[];
    readonly events: readonly RedlineEvent[];
    // The documents were too large to align, so the whole old text is struck and the whole new text underlined.
    readonly whole: boolean;
}

export interface RedlineOptions {
    // What stands in for a picture the old document had and the new one has not; its bytes are the old package's.
    readonly removedPicture: string;
}

// The class every marked paragraph carries, and the per-kind and per-event classes beside it.
export const MARK_CLASS = `docx-redline`;

// A piece of a paragraph's text: one run child (or a whole paragraph-level child that has no text), where it sits.
interface Piece {
    readonly container?: DocxNode;
    readonly run?: DocxNode;
    readonly child: DocxNode;
    readonly text: string;
}

type Block =
    | { readonly kind: "paragraph"; readonly node: DocxNode; readonly pieces: readonly Piece[]; readonly text: string }
    | { readonly kind: "table"; readonly node: DocxNode; readonly rows: readonly Row[]; readonly text: string }
    | { readonly kind: "other"; readonly node: DocxNode; readonly text: string };

interface Row {
    readonly node: DocxNode;
    readonly cells: readonly Cell[];
    readonly text: string;
}

interface Cell {
    readonly node: DocxNode;
    readonly blocks: readonly Block[];
}

// A picture, a symbol from a symbol font: one character the word diff can move as a word.
const OBJECT = `￼`;

// Revision wrappers a document was saved with: read at their accepted state, so what is compared is what a reader
// of either version would accept.
const accepted = (children: readonly DocxNode[]): DocxNode[] =>
    children.flatMap((child) => (child.type === `inserted` ? accepted(child.children ?? []) : child.type === `deleted` ? [] : [child]));

// What each kind of run child contributes to its paragraph's text; a kind not named here has none (a field
// instruction, a footnote mark, a comment anchor) and rides with the text beside it.
const RUN_CHILD_TEXT: Readonly<Record<string, string>> = { tab: `\t`, noBreakHyphen: `‑`, symbol: OBJECT, drawing: OBJECT, image: OBJECT, vmlPicture: OBJECT };

const textOfRunChild = (child: DocxNode): string => {
    if (child.type === `text`) {
        return child.text ?? ``;
    }
    if (child.type === `break`) {
        return child.break === `textWrapping` ? `\n` : ``;
    }
    return RUN_CHILD_TEXT[child.type] ?? ``;
};

const isPageBreak = (child: DocxNode): boolean => child.type === `break` && child.break !== `textWrapping`;
const isPicture = (child: DocxNode): boolean => child.type === `drawing` || child.type === `image` || child.type === `vmlPicture`;

const piecesOfRun = (run: DocxNode, container: DocxNode | undefined): Piece[] =>
    (run.children ?? []).map((child) => ({ ...(container === undefined ? {} : { container }), run, child, text: textOfRunChild(child) }));

const piecesOfParagraph = (paragraph: DocxNode): Piece[] =>
    accepted(paragraph.children ?? []).flatMap((child) => {
        if (child.type === `run`) {
            return piecesOfRun(child, undefined);
        }
        if (child.type === `hyperlink` || child.type === `smartTag`) {
            return accepted(child.children ?? []).flatMap((run) => (run.type === `run` ? piecesOfRun(run, child) : [{ container: child, child: run, text: `` }]));
        }
        return [{ child, text: `` }];
    });

const blockOf = (node: DocxNode): Block => {
    if (node.type === `paragraph`) {
        const pieces = piecesOfParagraph(node);
        return { kind: `paragraph`, node, pieces, text: pieces.map((piece) => piece.text).join(``) };
    }
    if (node.type === `table`) {
        const rows = (node.children ?? [])
            .filter((row) => row.type === `row`)
            .map((row): Row => {
                const cells = (row.children ?? []).filter((cell) => cell.type === `cell`).map((cell): Cell => ({ node: cell, blocks: blocksOf(cell.children ?? []) }));
                return { node: row, cells, text: cells.map((cell) => cell.blocks.map((block) => block.text).join(`\n`)).join(`\t`) };
            });
        return { kind: `table`, node, rows, text: rows.map((row) => row.text).join(`\n`) };
    }
    return { kind: `other`, node, text: `` };
};

const blocksOf = (children: readonly DocxNode[]): Block[] => accepted(children).map(blockOf);

const sameBlock = (left: Block, right: Block): boolean => left.kind === right.kind && left.text === right.text;

// Below this share of common words, a removed block and the added one after it are two blocks, not one edited; the
// same line the app's prose diff draws.
const ALIKE = 0.4;
const alikeBlocks = (left: Block, right: Block): boolean => left.kind === right.kind && (left.kind !== `paragraph` || similarity(left.text, right.text) >= ALIKE);
const alikeRows = (left: Row, right: Row): boolean => similarity(left.text, right.text) >= ALIKE;
// Inside a paired cell the paragraphs are positional: a value replaced by another is that cell edited.
const alikeCellBlocks = (left: Block, right: Block): boolean => left.kind === right.kind;

// The part of a piece sitting at [from, to) that falls inside [start, end): the piece whole, a text child cut to
// the overlap, or nothing.
const cut = (piece: Piece, from: number, to: number, start: number, end: number): Piece | undefined => {
    const cutFrom = Math.max(from, start);
    const cutTo = Math.min(to, end);
    if (cutFrom >= cutTo) {
        return undefined;
    }
    if ((cutFrom === from && cutTo === to) || piece.child.type !== `text`) {
        return piece;
    }
    const text = piece.text.slice(cutFrom - from, cutTo - from);
    return { ...piece, child: { ...piece.child, text }, text };
};

// Pieces of one paragraph covering [start, end) of its text, text children cut at the edges. A piece with no text
// sits at one offset and goes with the range that holds it; `last` also takes those at the very end.
const slicePieces = (pieces: readonly Piece[], start: number, end: number, last: boolean): Piece[] => {
    const out: Piece[] = [];
    let at = 0;
    for (const piece of pieces) {
        const from = at;
        at += piece.text.length;
        if (piece.text.length === 0) {
            if (from >= start && (from < end || (last && from === end))) {
                out.push(piece);
            }
            continue;
        }
        const part = cut(piece, from, at, start, end);
        if (part !== undefined) {
            out.push(part);
        }
    }
    return out;
};

// Pieces back into paragraph children: consecutive pieces of one run become one run, runs of one hyperlink one
// hyperlink, each a copy so a run split across marks leaves its original whole.
const assemble = (pieces: readonly Piece[]): DocxNode[] => {
    const out: DocxNode[] = [];
    let container: { node: DocxNode; children: DocxNode[] } | undefined;
    let run: { node: DocxNode; children: DocxNode[] } | undefined;
    const flushRun = (): void => {
        if (run !== undefined) {
            (container?.children ?? out).push({ ...run.node, children: run.children });
            run = undefined;
        }
    };
    const flushContainer = (): void => {
        flushRun();
        if (container !== undefined) {
            out.push({ ...container.node, children: container.children });
            container = undefined;
        }
    };
    for (const piece of pieces) {
        if (piece.container !== container?.node) {
            flushContainer();
            if (piece.container !== undefined) {
                container = { node: piece.container, children: [] };
            }
        }
        if (piece.run === undefined) {
            flushRun();
            (container?.children ?? out).push(piece.child);
            continue;
        }
        if (piece.run !== run?.node) {
            flushRun();
            run = { node: piece.run, children: [] };
        }
        run.children.push(piece.child);
    }
    flushContainer();
    return out;
};

// A run holding a page break has to stay a direct child of its paragraph: the renderer looks for breaks one level
// down when it splits pages, and a break inside a revision wrapper would be missed.
const holdsPageBreak = (node: DocxNode): boolean => node.type === `run` && (node.children ?? []).some(isPageBreak);

// Old-document pieces inside a mark: a picture's bytes live in the old package, which the render has not, so it
// stands in as text; a page break of the old document is nobody's.
const struck = (pieces: readonly Piece[], options: RedlineOptions): Piece[] =>
    pieces.flatMap((piece) => {
        if (isPageBreak(piece.child)) {
            return [];
        }
        if (isPicture(piece.child)) {
            return [{ ...piece, child: { type: `text`, text: options.removedPicture }, text: options.removedPicture }];
        }
        return [piece];
    });

const wrap = (kind: "inserted" | "deleted", children: readonly DocxNode[]): DocxNode[] => (children.length === 0 ? [] : [{ type: kind, children }]);

// Added pieces go under one wrapper, except runs carrying page breaks, which follow it at paragraph level.
const inserted = (pieces: readonly Piece[]): DocxNode[] => {
    const nodes = assemble(pieces);
    return [...wrap(`inserted`, nodes.filter((node) => !holdsPageBreak(node))), ...nodes.filter(holdsPageBreak)];
};

const deleted = (pieces: readonly Piece[], options: RedlineOptions): DocxNode[] => wrap(`deleted`, assemble(struck(pieces, options)));

const marked = (node: DocxNode, kind: RedlineKind, event: number): DocxNode => ({
    ...node,
    className: [node.className, MARK_CLASS, `${MARK_CLASS}-${kind}`, `${MARK_CLASS}-e${event}`].filter((name) => name !== undefined && name !== ``).join(` `),
});

// The words of a paragraph matched to its edited self: the new paragraph's pieces, with what left it struck where
// it stood and what arrived underlined.
const changedParagraph = (before: readonly Piece[], after: readonly Piece[], segments: readonly Segment[], options: RedlineOptions): DocxNode[] => {
    const out: DocxNode[] = [];
    let b = 0;
    let a = 0;
    const lastAfter = segments.reduce((last, segment, index) => (segment.kind === `removed` ? last : index), -1);
    segments.forEach((segment, index) => {
        const length = segment.text.length;
        if (segment.kind === `same`) {
            out.push(...assemble(slicePieces(after, a, a + length, index === lastAfter)));
            a += length;
            b += length;
        } else if (segment.kind === `added`) {
            out.push(...inserted(slicePieces(after, a, a + length, index === lastAfter)));
            a += length;
        } else {
            out.push(...deleted(slicePieces(before, b, b + length, false), options));
            b += length;
        }
    });
    return out;
};

// The counter every event draws from, per redline.
class Events {
    readonly list: RedlineEvent[] = [];
    next(kind: RedlineKind): number {
        const id = this.list.length + 1;
        this.list.push({ id, kind });
        return id;
    }
}

const struckParagraph = (block: Extract<Block, { kind: "paragraph" }>, event: number, options: RedlineOptions): DocxNode =>
    marked({ ...block.node, sectionProps: undefined, children: deleted(block.pieces, options) }, `removed`, event);

const underlinedParagraph = (block: Extract<Block, { kind: "paragraph" }>, event: number): DocxNode =>
    marked({ ...block.node, children: inserted(block.pieces) }, `added`, event);

// A block (or a whole table's worth of them) marked as one event, every paragraph in it struck or underlined.
const wholeBlocks = (blocks: readonly Block[], kind: "added" | "removed", event: number, options: RedlineOptions): DocxNode[] =>
    blocks.map((block) => {
        if (block.kind === `paragraph`) {
            return kind === `added` ? underlinedParagraph(block, event) : struckParagraph(block, event, options);
        }
        if (block.kind === `table`) {
            return {
                ...block.node,
                children: block.rows.map((row) => ({ ...row.node, children: row.cells.map((cell) => ({ ...cell.node, children: wholeBlocks(cell.blocks, kind, event, options) })) })),
            };
        }
        return block.node;
    });

// Two tables paired: rows matched by their text, a row matched to an edited self compared cell by cell, cells by
// their paragraphs; a row only one table has is that row, struck or underlined whole.
const changedTable = (before: Extract<Block, { kind: "table" }>, after: Extract<Block, { kind: "table" }>, events: Events, options: RedlineOptions): DocxNode => {
    const ops = diffSequence(before.rows, after.rows, (left, right) => left.text === right.text);
    if (ops === undefined) {
        const removed = events.next(`removed`);
        const added = events.next(`added`);
        return { ...after.node, children: [...wholeBlocks([before], `removed`, removed, options).flatMap((node) => node.children ?? []), ...wholeBlocks([after], `added`, added, options).flatMap((node) => node.children ?? [])] };
    }
    const rows = pairEdits(ops, alikeRows).flatMap((edit): DocxNode[] => {
        if (edit.kind === `same`) {
            return [edit.after.node];
        }
        if (edit.kind === `pair`) {
            const cells = Array.from({ length: Math.max(edit.before.cells.length, edit.after.cells.length) }, (_, index): DocxNode => {
                const from = edit.before.cells[index];
                const to = edit.after.cells[index];
                if (from !== undefined && to !== undefined) {
                    return { ...to.node, children: mergeBlocks(from.blocks, to.blocks, events, options, alikeCellBlocks) };
                }
                if (to !== undefined) {
                    return { ...to.node, children: wholeBlocks(to.blocks, `added`, events.next(`added`), options) };
                }
                return { ...from!.node, children: wholeBlocks(from!.blocks, `removed`, events.next(`removed`), options) };
            });
            return [{ ...edit.after.node, children: cells }];
        }
        const event = events.next(edit.kind);
        return [{ ...edit.item.node, children: edit.item.cells.map((cell) => ({ ...cell.node, children: wholeBlocks(cell.blocks, edit.kind, event, options) })) }];
    });
    return { ...after.node, children: rows };
};

// A block matched to an edited self: words for a paragraph, rows for a table, removed-then-added for anything else
// or for a paragraph that became a table.
const changedBlock = (before: Block, after: Block, events: Events, options: RedlineOptions): DocxNode[] => {
    if (before.kind === `paragraph` && after.kind === `paragraph`) {
        const event = events.next(`changed`);
        return [marked({ ...after.node, children: changedParagraph(before.pieces, after.pieces, wordDiff(before.text, after.text), options) }, `changed`, event)];
    }
    if (before.kind === `table` && after.kind === `table`) {
        return [changedTable(before, after, events, options)];
    }
    return [...wholeBlocks([before], `removed`, events.next(`removed`), options), ...wholeBlocks([after], `added`, events.next(`added`), options)];
};

const mergeBlocks = (before: readonly Block[], after: readonly Block[], events: Events, options: RedlineOptions, alike = alikeBlocks): DocxNode[] => {
    const ops = diffSequence(before, after, sameBlock);
    if (ops === undefined) {
        return [...wholeBlocks(before, `removed`, events.next(`removed`), options), ...wholeBlocks(after, `added`, events.next(`added`), options)];
    }
    return pairEdits(ops, alike).flatMap((edit): DocxNode[] => {
        switch (edit.kind) {
            case `same`:
                return [edit.after.node];
            case `pair`:
                return changedBlock(edit.before, edit.after, events, options);
            default:
                return wholeBlocks([edit.item], edit.kind, events.next(edit.kind), options);
        }
    });
};

/** The new body's children with the old one's departures struck into them, and what happened, in order. */
export const redline = (before: readonly DocxNode[], after: readonly DocxNode[], options: RedlineOptions): Redline => {
    const events = new Events();
    const beforeBlocks = blocksOf(before);
    const afterBlocks = blocksOf(after);
    const whole = diffSequence(beforeBlocks, afterBlocks, sameBlock) === undefined;
    const children = mergeBlocks(beforeBlocks, afterBlocks, events, options);
    return { children, events: events.list, whole };
};

/** Plain text of a body, paragraph per line, the same reading the redline aligns on; for tests and the verdict. */
export const textOfBody = (children: readonly DocxNode[]): string => blocksOf(children).map((block) => block.text).join(`\n`);
