import type { ProsePart } from "@intentic/ui";
import { type MarkdownBlock, type MarkdownDecorator, renderMarkdownParts, type RenderedMarkdown } from "@intentic/ui/markdown";

/* EDITING A DOCUMENT ONE BLOCK AT A TIME, the model behind MarkdownViewer's pretty-editing surface.
 *
 * The surface renders prose and lets the reader click a paragraph to edit THAT paragraph's markdown while the
 * rest of the document stays rendered. Two jobs live here, and both are pure so the one that can corrupt a file
 * is testable without mounting anything:
 *
 *   what to DRAW, a part list with the active block replaced by a slot the surface fills with its editor, and
 *   what to KEEP, the document with one block's text swapped for what the user typed.
 *
 * BLOCK BY BLOCK, NOT DOCUMENT MINUS A HOLE. Rendering "everything before" and "everything after" as two chunks
 * would re-parse the whole document on every click, which is a re-render of the entire file to move a caret one
 * paragraph. Rendering each block on its own and remembering the result means a click re-parses exactly the two
 * blocks whose state changed, so activation stays flat as documents grow, which is the entire promise of editing
 * in place rather than in a source view.
 *
 * That costs one thing and it is paid for below: a block parsed alone cannot see a link definition that lives in
 * another block, so `[text][ref]` would render as literal brackets. The definitions come along as a prelude on
 * every block (splitMarkdownBlocks hands them over for exactly this). They render to nothing, so prepending them
 * adds nothing to the output and only puts the references back in scope.
 *
 * The engine is reached directly here rather than through the app's renderMarkdown module, because this renders
 * with a decorator it is HANDED rather than one it builds: the surface above still gets that decorator from the
 * app module (fileLinkDecorator, which is the only thing that knows where a file mention points), so prose here
 * carries the same links as everywhere else.
 *
 * TRAILING BLANK LINES ARE STRUCTURE, NOT TEXT. A block's span reaches to the start of the next one, so a
 * paragraph's source ends `…\n\n`. Showing that in the editor makes every block two lines taller than its text
 * and invites the user to delete the blank line that is holding the document apart. So the editor is handed the
 * text without it and the exact original run is put back on commit: the gaps between blocks survive editing
 * untouched, and a user who wants to close one goes to the source view, which is what it is for. */

/** A document's block texts, rendered and remembered, for one file and one decorator. */
export interface BlockRenderer {
    /** The reading flow: every block rendered, with `active` (when given) replaced by a slot the caller fills. */
    readonly parts: (source: string, blocks: readonly MarkdownBlock[], defs: string, active: number | undefined) => readonly ProsePart[];
}

/* One document's worth of rendered blocks, at most. A file switch builds a new renderer (the decorator changes
 * with the document's directory), so this never has to hold two files at once; the cap is only there so a long
 * editing session on one enormous file cannot grow it without bound. Insertion-ordered, so eviction is oldest
 * first: blocks are rendered in reading order, and the ones a reader is nowhere near are the ones to drop. */
const CACHE_LIMIT = 600;

const preludeFor = (defs: string): string => (defs === `` ? `` : `${defs}\n\n`);

/**
 * A renderer for one file's blocks. Held across edits so a keystroke re-renders the block it changed rather
 * than the document around it; discarded when the file (or its decorator) changes.
 */
export const createBlockRenderer = (decorate: MarkdownDecorator | undefined): BlockRenderer => {
    const cache = new Map<string, RenderedMarkdown>();

    const render = (text: string, prelude: string): RenderedMarkdown => {
        const cached = cache.get(text);
        if (cached !== undefined) {
            return cached;
        }
        /* Parsed WITH the prelude and rendered without it: definitions produce no output, so the parts that come
         * back are the block's own. Not sliced or trimmed afterwards, there is nothing of the prelude in them. */
        const parts = renderMarkdownParts(prelude + text, decorate);
        cache.set(text, parts);
        if (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next();
            if (!oldest.done) {
                cache.delete(oldest.value);
            }
        }
        return parts;
    };

    return {
        parts: (source, blocks, defs, active) => {
            const prelude = preludeFor(defs);
            return blocks.flatMap((block, index): ProsePart[] =>
                index === active ? [{ kind: `slot`, key: `block` }] : [...render(source.slice(block.start, block.end), prelude)],
            );
        },
    };
};

// The trailing run of newlines that holds a block apart from the next one. Never shown to the block editor and
// always put back on commit, so the document's own spacing is not something a paragraph edit can disturb.
const trailingNewlines = (text: string): string => /\n*$/u.exec(text)?.[0] ?? ``;

/** A block's source as the editor should show it: its text, without the blank lines that separate it from the next. */
export const blockText = (source: string, block: MarkdownBlock): string => {
    const raw = source.slice(block.start, block.end);
    return raw.slice(0, raw.length - trailingNewlines(raw).length);
};

/**
 * The document with `block` replaced by `edited`.
 *
 * The block's original trailing blank lines are restored around whatever the user typed, so the gap to the next
 * block is exactly the gap that was there before: an edit changes a paragraph, never the document's shape.
 */
export const spliceBlock = (source: string, block: MarkdownBlock, edited: string): string => {
    const raw = source.slice(block.start, block.end);
    const gap = trailingNewlines(raw);
    const body = edited.slice(0, edited.length - trailingNewlines(edited).length);
    return source.slice(0, block.start) + body + gap + source.slice(block.end);
};

/* A task-list marker: the bullet, then its `[ ]` or `[x]`. Anchored per line, so a `[x]` sitting in the middle
 * of a sentence is prose and stays prose. Ordered items count too: `1. [ ] ship it` is a task list in GFM. */
const TASK_MARKER = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gmu;

/**
 * The document with its `index`-th task checkbox flipped, or undefined when there is no such checkbox.
 *
 * Ticking a box is the one edit a READER makes: it is a fact about the work, not a change to the prose, and
 * every other surface that shows a checklist lets you click it. So it stays available while the document is
 * locked, which is the same line VS Code's markdown editor draws (its rendered controls keep working in
 * read-only mode; only typing is refused).
 */
export const toggleTaskCheckbox = (source: string, index: number): string | undefined => {
    TASK_MARKER.lastIndex = 0;
    for (let seen = 0; ; seen += 1) {
        const match = TASK_MARKER.exec(source);
        if (match === null) {
            return undefined;
        }
        if (seen === index) {
            const bullet = match[1] ?? ``;
            const ticked = (match[2] ?? ` `) !== ` `;
            const at = match.index + bullet.length;
            return `${source.slice(0, at)}[${ticked ? ` ` : `x`}]${source.slice(at + 3)}`;
        }
    }
};

/**
 * Where `offset` ends up once `block` has been replaced by text `delta` characters longer (or shorter).
 *
 * Clicking a second paragraph while a first one is open does two things at once: it commits the open block and
 * it opens the clicked one. The click was measured against the document as it stood BEFORE the commit, so
 * anything after the edited block has moved by then; this is what carries the click across.
 */
export const shiftOffset = (block: MarkdownBlock, delta: number, offset: number): number => (offset < block.end ? offset : offset + delta);

/* WHERE THE CLICK LANDED, IN THE SOURCE. Clicking a word in rendered prose has to put the caret on that word in
 * the markdown behind it, or "click where you are reading and type" is a promise the surface does not keep: land
 * at the end of the paragraph instead and every edit starts with the user hunting for their own cursor.
 *
 * A full rendered-to-source position map is the thing this surface deliberately does not build (it would mean
 * owning the parser's inline offsets, i.e. writing a text editor). What it does instead is SEARCH: take the
 * rendered text the user clicked past, use its tail as a needle, and find the same tail in the block's source.
 * For ordinary prose the source contains the visible text verbatim, so this is exact. Where it is not (the
 * needle straddles a `**` or a link's brackets) the needle shortens until something matches, and the caret lands
 * a word or two off rather than nowhere. Nothing is riding on it being perfect: a wrong caret costs one click to
 * correct, and no edit has happened yet.
 *
 * Whitespace is matched loosely because rendering collapses it: a paragraph wrapped over two source lines is one
 * line of prose, so a needle spanning that wrap has a space where the source has a newline. */
const MAX_NEEDLE = 32;

const asLooseWhitespacePattern = (needle: string): RegExp =>
    new RegExp(
        needle
            .split(/\s+/u)
            .map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
            .join(String.raw`\s+`),
        `gu`,
    );

// How many times `needle` already occurred in `prefix` before this final one, so the same occurrence is taken in
// the source. Without it, clicking the second "the" in a paragraph lands on the first.
const occurrencesBefore = (prefix: string, needleLength: number): number => {
    const pattern = asLooseWhitespacePattern(prefix.slice(prefix.length - needleLength));
    const upToClick = prefix.slice(0, prefix.length - needleLength);
    let count = 0;
    while (pattern.exec(upToClick) !== null) {
        count += 1;
        if (count > prefix.length) {
            break; // A zero-width pattern would otherwise spin; nothing legitimate reaches this.
        }
    }
    return count;
};

/**
 * The offset in a block's SOURCE for a caret that sits after `renderedPrefix` characters of its rendered text.
 *
 * Falls back to the end of the block when the rendered text cannot be found, which is the honest answer for a
 * click on something with no source of its own (a table's borders, a rendered checkbox).
 */
export const caretOffsetInSource = (renderedPrefix: string, source: string): number => {
    if (renderedPrefix === ``) {
        return 0;
    }
    for (let length = Math.min(MAX_NEEDLE, renderedPrefix.length); length > 0; length -= 1) {
        const skip = occurrencesBefore(renderedPrefix, length);
        const pattern = asLooseWhitespacePattern(renderedPrefix.slice(renderedPrefix.length - length));
        for (let seen = 0; ; seen += 1) {
            const match = pattern.exec(source);
            if (match === null) {
                break;
            }
            if (seen === skip) {
                return match.index + match[0].length;
            }
        }
    }
    return source.length;
};
