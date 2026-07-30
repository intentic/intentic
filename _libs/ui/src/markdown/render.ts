import DOMPurify from "dompurify";
import { Marked } from "marked";
import { type CodeBlock, codeBlockHtml, escapeHtml } from "./code.js";

/* Render untrusted markdown (workspace files, agent chat output, memory notes) to SANITIZED HTML for v-html.
 * Vue's v-html does NOT sanitize, so we must do it ourselves — marked passes inline HTML through, so without
 * this a workspace file or a crafted agent turn could inject <script>/onerror. DOMPurify strips the active
 * markup while keeping the prose.
 *
 * This is the ONE markdown engine in the product: the chat transcript, the workspace file preview and every
 * extension view that renders prose (via <Markdown>) run through it, so none of them can drift apart in what
 * they accept or how they escape it. Surface-specific behaviour arrives as a `decorate` hook rather than a
 * fork — see MarkdownDecorator. */

/* Fenced code blocks are collected out of band and left as an index-only placeholder, which markdown/code.ts
 * fills in after sanitizing (see codeBlockHtml for why that order). The collector is module state because
 * marked.parse is synchronous — it is filled and drained inside a single call.
 *
 * A crafted turn could write that placeholder as literal HTML and have one of its OWN code blocks rendered
 * twice; there is nothing else to gain, since the substituted markup is ours, so this stays unguarded rather
 * than carrying a per-render nonce. */
let collected: CodeBlock[] = [];
const marked = new Marked({
    renderer: {
        code({ text, lang }) {
            collected.push({ code: text, lang: lang ?? `` });
            return `<pre data-md-code="${collected.length - 1}"></pre>`;
        },
    },
});
const CODE_PLACEHOLDER = /<pre data-md-code="(\d+)"><\/pre>/g;

/* A surface's own pass over the sanitized DOM, before it is serialized for v-html. The app uses it to turn
 * file mentions into workspace links (markdownFileLinks) — knowledge of routes and the workspace tree that
 * belongs to the app, not to the design system, and that an extension has no business inheriting.
 *
 * It runs AFTER the sanitizer, never before, so whatever it adds survives exactly as written; the contract is
 * that a decorator only ever authors markup of its own, never re-admits markup from the source. */
export type MarkdownDecorator = (fragment: DocumentFragment) => void;

// Sanitized HTML plus the code blocks its placeholders stand for. Split from substitution so a streaming
// turn can parse its settled prefix once and still pick up highlighting that lands later.
interface MarkdownParts {
    readonly html: string;
    readonly blocks: readonly CodeBlock[];
}

const EMPTY: MarkdownParts = { html: ``, blocks: [] };

// Number of markdown parses since load. The streaming split exists to keep this proportional to an answer's
// BLOCK count rather than its frame count; renderMarkdown.test.ts asserts exactly that, which is the only
// reason it is exported.
let parses = 0;
export const markdownParseCount = (): number => parses;

// Markup that IS the content, so a block holding one of these is visible even with no text in it. Anything
// else empty of text renders as nothing at all — see `vanished`.
const SELF_SHOWING = `img, hr, svg, video, audio, canvas, input`;

/* Whether a parse turned prose into markup the user cannot see: text went in, no text (and no code block, and
 * nothing self-showing) came out. A short answer that is nothing BUT a block marker does exactly that — a bare
 * "4." is a valid ordered-list item with empty content, so `<ol start="4"><li></li></ol>` is all that reaches
 * the bubble and the turn reads as if the model never answered. The caller then falls back to the escaped
 * source, which is what the model meant by it. Also covers a lone "#", "-", "1)", ">" and the streaming tail
 * frame where a list marker has arrived but its content has not. */
const vanished = (holder: HTMLElement, text: string): boolean =>
    collected.length === 0 && text.trim() !== `` && (holder.textContent ?? ``).trim() === `` && holder.querySelector(SELF_SHOWING) === null;

/* Never let a markdown/sanitizer edge case (or a non-string slipping in mid-stream) crash the surrounding
 * component — a chat bubble re-runs this on every streamed delta, so a single throw would blank the turn.
 * On any failure, fall back to the raw text, HTML-escaped, so the content still shows (just unstyled).
 *
 * Sanitizing to a FRAGMENT rather than a string is what lets a decorator (markdownFileLinks) rewrite the DOM
 * without a second parse: DOMPurify builds this DOM either way and would only have serialized it for us to
 * re-parse. */
const parseParts = (text: string, decorate: MarkdownDecorator | undefined): MarkdownParts => {
    parses += 1;
    collected = [];
    try {
        const fragment = DOMPurify.sanitize(marked.parse(text, { async: false }), { RETURN_DOM_FRAGMENT: true });
        decorate?.(fragment);
        const holder = document.createElement(`div`);
        holder.append(fragment);
        return vanished(holder, text) ? { html: escapeHtml(text), blocks: [] } : { html: holder.innerHTML, blocks: collected };
    } catch {
        return { html: escapeHtml(text), blocks: [] };
    }
};

// Swap each placeholder for its real markup. Runs on every render rather than being memoised with the parse,
// so a block that was still uncoloured when it settled picks up its highlighting as soon as that arrives.
const substitute = (parts: MarkdownParts, colour: boolean): string =>
    parts.blocks.length === 0
        ? parts.html
        : parts.html.replace(CODE_PLACEHOLDER, (match, index: string) => {
              const at = Number(index);
              const block = parts.blocks[at];
              return block === undefined ? match : codeBlockHtml(block, at, colour);
          });

const asText = (source: string): string => (typeof source === `string` ? source : String(source ?? ``));

// Whole-message render: everything is finished text, so every code block is worth colouring.
export const renderMarkdown = (source: string, decorate?: MarkdownDecorator): string => substitute(parseParts(asText(source), decorate), true);

/* Streaming split — the answer a turn is still writing is re-rendered on every animation frame (the
 * typewriter loop appends a few characters per frame), and re-parsing + re-sanitizing the WHOLE message each
 * time is quadratic in its length. It also replaced the bubble's entire innerHTML every frame, which destroys the
 * DOM under the user's cursor and so makes text unselectable while a turn streams.
 *
 * Both go away by splitting the message at the last point that is provably finished: everything before it is
 * parsed once and handed back byte-identical on later frames (Vue then skips patching that v-html entirely,
 * so its DOM — and any selection inside it — survives), and only the short unfinished tail is re-parsed. */

// A fence opens or closes a code block, inside which a blank line is content rather than a block boundary.
const FENCE = /^ {0,3}(?:```|~~~)/;
// Splitting between two list blocks renders them as separate lists — which restarts an ordered list's
// numbering and breaks a loose list in two — so a boundary is never taken between them.
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/;
// Four spaces or a tab continues the block above (an indented code block, a list item's body), so a boundary
// immediately before one would cut that block in half.
const CONTINUATION = /^(?: {4}|\t)/;

// The last non-blank line ending at `end`, so a boundary check knows what the settled text left off with.
const lineBefore = (text: string, end: number): string => {
    for (let stop = end; stop > 0;) {
        const start = text.lastIndexOf(`\n`, stop - 1) + 1;
        const line = text.slice(start, stop);
        if (line.trim() !== ``) {
            return line;
        }
        stop = start - 1 > 0 ? start - 1 : 0;
        if (start === 0) {
            break;
        }
    }
    return ``;
};

/* The index up to which `text` is finished markdown — content that later streaming cannot change. Scans only
 * from `from` (a boundary this returned earlier, which is always a line start outside any fence), so the walk
 * costs the new text rather than the whole message.
 *
 * A boundary is a blank line, confirmed only once the FOLLOWING line has arrived: without seeing what comes
 * next there is no way to know whether the blank line ends the block or sits inside one. That also means the
 * line currently being typed never settles, which is exactly the intent. */
export const settledEnd = (text: string, from: number): number => {
    let settled = from;
    let inFence = false;
    let previous = lineBefore(text, from);
    // Index just past a blank line, held until the next non-blank line proves it safe to cut there.
    let pending: number | undefined;
    let lineStart = from;
    for (let index = from; index <= text.length; index += 1) {
        if (index < text.length && text[index] !== `\n`) {
            continue;
        }
        const line = text.slice(lineStart, index);
        lineStart = index + 1;
        if (FENCE.test(line)) {
            // A fence line always begins a new block, so a boundary waiting in front of one is safe to take.
            // (Only an OPENING fence can have a pending boundary — blank lines inside a fence never set one.)
            if (pending !== undefined) {
                settled = pending;
                pending = undefined;
            }
            inFence = !inFence;
            previous = line;
            continue;
        }
        if (inFence) {
            continue;
        }
        if (line.trim() === ``) {
            pending ??= lineStart;
            continue;
        }
        if (pending !== undefined && !CONTINUATION.test(line) && !(LIST_ITEM.test(line) && LIST_ITEM.test(previous))) {
            settled = pending;
        }
        pending = undefined;
        previous = line;
    }
    return settled;
};

export interface RenderedMarkdown {
    // `settled` is stable across frames for a given prefix; `tail` is the part still being written.
    readonly settled: string;
    readonly tail: string;
}

export interface StreamingMarkdown {
    readonly render: (source: string) => RenderedMarkdown;
}

// One renderer per streaming message (the caller holds it for the message's lifetime).
export const createStreamingMarkdown = (decorate?: MarkdownDecorator): StreamingMarkdown => {
    let boundary = 0;
    let settledSource = ``;
    let settledParts = EMPTY;
    return {
        render: (source) => {
            const text = asText(source);
            // Not an append but a rewrite (an edited re-run, a bubble reused for a new turn) — start over.
            if (!text.startsWith(settledSource)) {
                boundary = 0;
                settledSource = ``;
                settledParts = EMPTY;
            }
            const next = settledEnd(text, boundary);
            if (next > boundary) {
                boundary = next;
                settledSource = text.slice(0, next);
                // The whole settled prefix is re-parsed rather than appending the new chunk's HTML: a block
                // that only renders correctly in the presence of its predecessors (a list continuing across
                // the cut, a reference-style link defined earlier) then still does, and any seam artifact in
                // the tail heals the moment it settles. This runs once per completed block — not per frame,
                // which is the entire point.
                settledParts = parseParts(settledSource, decorate);
            }
            // The tail is not coloured: its text changes every frame, so highlighting it would thrash the
            // cache for a block that is about to settle and be highlighted exactly once.
            return { settled: substitute(settledParts, true), tail: substitute(parseParts(text.slice(boundary), decorate), false) };
        },
    };
};
