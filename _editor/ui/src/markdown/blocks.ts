import { splitFrontmatter } from "./frontmatter.js";
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

// The lexer's `raw`s must reassemble what was lexed, or every offset below is a guess at where a block starts.
const reassembles = (tokens: readonly { readonly raw: string }[], body: string): boolean => {
    let total = 0;
    for (const token of tokens) {
        total += token.raw.length;
    }
    return total === body.length && tokens.map((token) => token.raw).join(``) === body;
};

// Walks the tokens into spans, `head` characters along from the document's start (what the metadata block took).
const spansOf = (tokens: readonly { readonly type: string; readonly raw: string }[], head: number): MarkdownBlocks => {
    const blocks: MarkdownBlock[] = head === 0 ? [] : [{ start: 0, end: head }];
    const defs: string[] = [];
    let at = head;
    // Leading invisible tokens (before any block exists) are held here until the first visible token claims them.
    let pending: number | undefined;
    for (const token of tokens) {
        const start = at;
        at += token.raw.length;
        if (!INVISIBLE.has(token.type)) {
            blocks.push({ start: pending ?? start, end: at });
            pending = undefined;
            continue;
        }
        if (token.type === `def`) {
            defs.push(token.raw);
        }
        const last = blocks.at(-1);
        if (last === undefined) {
            pending ??= start;
            continue;
        }
        blocks[blocks.length - 1] = { start: last.start, end: at };
    }
    return { blocks, defs: defs.join(`\n`) };
};

/** Splits `source` into the spans a reader can edit one at a time. */
export const splitMarkdownBlocks = (source: string): MarkdownBlocks => {
    if (typeof source !== `string` || source === ``) {
        return { blocks: [], defs: `` };
    }
    // Metadata is one span, not the rule-plus-heading the lexer reads it as: its lines are edited together, as YAML.
    const matter = splitFrontmatter(source);
    const head = matter?.matter.raw.length ?? 0;
    const body = matter?.rest ?? source;
    const tokens = lexBlocks(body);
    if (tokens === undefined || !reassembles(tokens, body)) {
        return whole(source);
    }
    const split = spansOf(tokens, head);
    // An all-invisible document (blank lines or definitions alone) still needs an editable block.
    return split.blocks.length === 0 ? whole(source) : split;
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
