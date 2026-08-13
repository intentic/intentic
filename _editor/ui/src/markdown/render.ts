import DOMPurify from "dompurify";
import { Marked } from "marked";
import { type CodeBlock, codeBlockHtml, escapeHtml } from "./code.js";
import { type Figure, splitFigureSegments } from "./figures.js";

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

// One prose run's sanitized HTML plus the code blocks its placeholders stand for. Split from substitution so a
// streaming turn can parse its settled prefix once and still pick up highlighting that lands later.
interface MarkdownParts {
    readonly html: string;
    readonly blocks: readonly CodeBlock[];
}

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

// ONE PROSE RUN, as a string. The engine's smallest unit and everything below is built out of it; a surface
// renders a whole document through the parts API instead, which is the only shape a figure fits in.
export const renderMarkdown = (source: string, decorate?: MarkdownDecorator): string => substitute(parseParts(asText(source), decorate), true);

/* ---- a document, as the pieces a surface can actually mount ------------------------------------------------
 *
 * A figure fence (figures.ts) is a COMPONENT, and there is nowhere in an HTML string to put one — so a document
 * that holds figures cannot be rendered as one v-html and a surface that insists on a string is a surface where
 * every diagram stays a wall of arrow syntax. That was the chat transcript for as long as it rendered its two
 * streaming halves as two strings: the file preview drew the mermaid an agent wrote, and the answer that wrote
 * it did not.
 *
 * So the engine's document-level output is a LIST: prose runs already sanitized to HTML, and figures as data
 * for the caller to draw. A document without figures is one part and renders exactly as it always did, which is
 * the property that keeps this free — no surface pays markup, layout or a wrapper for a feature it never uses. */
export type MarkdownPart = { readonly kind: "html"; readonly html: string } | { readonly kind: "figure"; readonly figure: Figure };

export type RenderedMarkdown = readonly MarkdownPart[];

/* The parse, held between renders. A prose run keeps its parsed PARTS rather than its finished html because
 * substitution has to run again on every render — a code block that was still uncoloured when its run settled
 * picks up its highlighting from a later pass (see `substitute`) without re-parsing anything. */
type ParsedPart = { readonly kind: "prose"; readonly parts: MarkdownParts } | { readonly kind: "figure"; readonly figure: Figure };

const parseDocument = (text: string, decorate: MarkdownDecorator | undefined): readonly ParsedPart[] =>
    splitFigureSegments(text).map((segment) =>
        segment.kind === `prose` ? { kind: `prose`, parts: parseParts(segment.text, decorate) } : { kind: `figure`, figure: segment.figure },
    );

/* A parsed document → what the surface renders. Figure parts are passed through BY IDENTITY, which is what
 * keeps a diagram from being redrawn on every frame of a streaming turn: the prop the component receives is the
 * same object it already has, so it never re-renders, never re-imports mermaid, and never flashes its
 * placeholder in the middle of an answer.
 *
 * An empty prose run is dropped rather than rendered as an empty wrapper. Surfaces style their first and last
 * block by position (prose.css), and a blank part at either end would take that position and silently move a
 * document's edges. */
const renderDocument = (document: readonly ParsedPart[], colour: boolean): MarkdownPart[] =>
    document.flatMap((part): MarkdownPart[] => {
        if (part.kind === `figure`) {
            return [part];
        }
        const html = substitute(part.parts, colour);
        return html === `` ? [] : [{ kind: `html`, html }];
    });

// Whole-message render: everything is finished text, so every code block is worth colouring and every closed
// figure fence is worth drawing.
export const renderMarkdownParts = (source: string, decorate?: MarkdownDecorator): RenderedMarkdown =>
    renderDocument(parseDocument(asText(source), decorate), true);

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

export interface StreamingMarkdown {
    readonly render: (source: string) => RenderedMarkdown;
}

// One renderer per streaming message (the caller holds it for the message's lifetime).
export const createStreamingMarkdown = (decorate?: MarkdownDecorator): StreamingMarkdown => {
    let boundary = 0;
    let settledSource = ``;
    let settled: readonly ParsedPart[] = [];
    return {
        render: (source) => {
            const text = asText(source);
            // Not an append but a rewrite (an edited re-run, a bubble reused for a new turn) — start over.
            if (!text.startsWith(settledSource)) {
                boundary = 0;
                settledSource = ``;
                settled = [];
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
                settled = parseDocument(settledSource, decorate);
            }
            /* The tail is split into parts too, not left as one string — otherwise a diagram DRAWS only once
             * something follows it, and the diagram an answer ends on is exactly the one nothing follows. It
             * would sit as arrow syntax for the rest of the turn (minutes, if the agent is running tools) and
             * become a picture at the end, which reads as the app noticing late.
             *
             * Splitting it is safe for the same reason settling is: a boundary is always outside a fence, so a
             * half-written diagram is never a figure — an unclosed fence stays prose by construction
             * (splitFigureSegments), and the closing backticks are what turn it into a picture.
             *
             * The tail is not coloured: its text changes every frame, so highlighting it would thrash the
             * cache for a block that is about to settle and be highlighted exactly once. */
            return [...renderDocument(settled, true), ...renderDocument(parseDocument(text.slice(boundary), decorate), false)];
        },
    };
};
