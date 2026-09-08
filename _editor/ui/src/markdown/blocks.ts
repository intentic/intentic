import { lexBlocks } from "./render.js";

// Source-offset spans behind the file viewer's per-paragraph editing surface. Spans tile the source with no gaps
// or overlaps, so an edit can safely splice one span back in. Blank lines and link definitions merge into the
// block above, since they render nothing on their own; untrustworthy offsets fall back to one block covering the
// whole document.

/** One editable span of a markdown document. Half-open: `[start, end)` in source characters. */
export interface MarkdownBlock {
    readonly start: number;
    readonly end: number;
}

export interface MarkdownBlocks {
    /** The document's blocks in order, tiling `[0, source.length)` with no gaps and no overlaps. */
    readonly blocks: readonly MarkdownBlock[];
    // Link-reference definitions' source; prepend when parsing one block alone so `[text][ref]` still resolves.
    readonly defs: string;
}

// Token types with no rendered output (`space`: blank-line run, `def`: `[ref]: url`); unreachable alone.
const INVISIBLE = new Set([`space`, `def`]);

const whole = (source: string): MarkdownBlocks => ({ blocks: source === `` ? [] : [{ start: 0, end: source.length }], defs: `` });

/**
 * Splits `source` into the spans a reader can edit one at a time. Falls back to one whole-document block whenever
 * the lexer's spans can't be trusted to reassemble the source exactly.
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
    // Leading invisible tokens (before any block exists) are held here until the first visible token claims them.
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
    // An all-invisible document (blank lines or definitions alone) still needs an editable block.
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
