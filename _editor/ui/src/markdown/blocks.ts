import { lexBlocks } from "./render.js";

/* A DOCUMENT AS THE PIECES YOU CAN EDIT ONE AT A TIME, the source-offset spans behind the file viewer's
 * pretty-editing surface (MarkdownViewer.vue).
 *
 * The surface it serves renders prose and lets the reader click a paragraph to edit THAT paragraph's markdown,
 * with the rest of the document staying rendered. To do that it needs to know where each block starts and ends
 * in the source, which is a question about markdown and therefore belongs to the engine rather than to the app:
 * the answer has to agree with what the renderer drew, and there is exactly one renderer.
 *
 * THE SPANS TILE THE SOURCE. Every character of the document belongs to exactly one block: `blocks[0]` starts
 * at 0, the last ends at `source.length`, and each one ends where the next begins. That is not tidiness, it is
 * what makes an edit safe: the surface replaces one span with the text the user typed and splices the document
 * back together, so a character in no block would be a character an edit could silently drop, and a character
 * in two would be one an edit could duplicate.
 *
 * The blank lines BETWEEN blocks (marked's `space` tokens) are therefore not blocks of their own: they hang off
 * the end of the block above, which is where a writer thinks they belong. Editing a paragraph and deleting its
 * trailing blank line is then a thing you can actually do.
 *
 * SO ARE LINK DEFINITIONS, for a different reason: `[ref]: https://…` renders to nothing at all, so a block
 * holding one would be an invisible, unclickable span of the document, i.e. text with no way to reach it. They
 * merge into the block above and travel with it, and their source is ALSO handed back separately as `defs` so a
 * block that uses `[text][ref]` can still be parsed with its references resolved when it is parsed alone.
 *
 * WHEN IN DOUBT, ONE BLOCK. The lexer's `raw` fields are the whole basis for the offsets here, and this checks
 * that they reassemble the source exactly before trusting them. Any document where they don't (or that the
 * lexer refuses outright) comes back as a single block covering everything: the surface then renders it as one
 * document and offers the whole file as the editable unit, which is the behaviour it had before this existed.
 * A wrong offset would corrupt a file; a coarse one only costs convenience. */

/** One editable span of a markdown document. Half-open: `[start, end)` in source characters. */
export interface MarkdownBlock {
    readonly start: number;
    readonly end: number;
}

export interface MarkdownBlocks {
    /** The document's blocks in order, tiling `[0, source.length)` with no gaps and no overlaps. */
    readonly blocks: readonly MarkdownBlock[];
    /* Every link-reference definition in the document, as source. A surface that parses one block on its own
     * prepends this, so `[text][ref]` still resolves against a definition that lives in another block; the
     * definitions render to nothing, so prepending them adds nothing to the output. Empty for the documents
     * that have none, which is most of them. */
    readonly defs: string;
}

// Token types that produce no rendered output, so a block of nothing but these would be unreachable on a
// surface you navigate by clicking. `space` is the blank-line run between two blocks; `def` is `[ref]: url`.
const INVISIBLE = new Set([`space`, `def`]);

const whole = (source: string): MarkdownBlocks => ({ blocks: source === `` ? [] : [{ start: 0, end: source.length }], defs: `` });

/**
 * Split `source` into the spans a reader can edit one at a time.
 *
 * Falls back to a single whole-document block whenever the lexer's spans cannot be trusted to reassemble the
 * source exactly, so a caller may always splice with what it gets back.
 */
export const splitMarkdownBlocks = (source: string): MarkdownBlocks => {
    if (typeof source !== `string` || source === ``) {
        return { blocks: [], defs: `` };
    }
    const tokens = lexBlocks(source);
    if (tokens === undefined) {
        return whole(source);
    }
    // The offsets below are only as good as `raw`, so prove it reassembles the document before using any of it.
    let total = 0;
    for (const token of tokens) {
        total += token.raw.length;
    }
    if (total !== source.length || tokens.map((token) => token.raw).join(``) !== source) {
        return whole(source);
    }

    const blocks: MarkdownBlock[] = [];
    const defs: string[] = [];
    let at = 0;
    /* Invisible tokens are absorbed rather than emitted: into the block above where there is one, and otherwise
     * held here until the first visible token arrives and takes them as its own leading text. That second case
     * is a document that opens with blank lines or with its link definitions, and the alternative, a first
     * block the reader cannot see or click, is exactly the hole this avoids. */
    let pending: number | undefined;
    for (const token of tokens) {
        const start = at;
        at += token.raw.length;
        if (INVISIBLE.has(token.type)) {
            if (token.type === `def`) {
                defs.push(token.raw);
            }
            const last = blocks.at(-1);
            if (last === undefined) {
                pending ??= start;
                continue;
            }
            blocks[blocks.length - 1] = { start: last.start, end: at };
            continue;
        }
        blocks.push({ start: pending ?? start, end: at });
        pending = undefined;
    }
    // Nothing visible in the whole document (blank lines, or definitions alone): it is still text someone has to
    // be able to edit, so it comes back as the one block it is.
    return blocks.length === 0 ? whole(source) : { blocks, defs: defs.join(`\n`) };
};

/** The index of the block holding `offset`, or -1 when the document has no blocks. Clamped at both ends. */
export const blockAtOffset = (blocks: readonly MarkdownBlock[], offset: number): number => {
    if (blocks.length === 0) {
        return -1;
    }
    const index = blocks.findIndex((block) => offset < block.end);
    return index === -1 ? blocks.length - 1 : index;
};

/** The character offset at which 1-based `line` starts, clamped to the document. */
export const offsetOfLine = (source: string, line: number): number => {
    let at = 0;
    for (let remaining = line - 1; remaining > 0; remaining -= 1) {
        const next = source.indexOf(`\n`, at);
        if (next === -1) {
            return at;
        }
        at = next + 1;
    }
    return at;
};
