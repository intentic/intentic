import DOMPurify from "dompurify";
import { Marked } from "marked";
import { type CodeBlock, codeBlockHtml, escapeHtml } from "./code.js";
import { type Figure, splitFigureSegments } from "./figures.js";

// Renders untrusted markdown (workspace files, chat output, memory notes) to sanitized HTML for v-html, which does
// not sanitize on its own. The one markdown engine in the product; surface-specific behavior goes through a
// `decorate` hook, not a fork.

// Code blocks are collected out of band into an index-only placeholder. `collected` is module state, not per-call:
// `marked.parse` is synchronous, so it fills and drains within one call. Left unguarded since a replay could only
// re-render the turn's own code block.
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

// A top-level token: only `type` and `raw` are exposed, for callers (blocks.ts) that need where a block sits in
// the source, not its parsed shape.
export interface MarkdownToken {
    readonly type: string;
    readonly raw: string;
    // Child tokens, if any; their `raw`s concatenate to the parent's, so a caller can find the parent's own markers by
    // subtraction.
    readonly tokens?: readonly MarkdownToken[];
}

// Returns undefined rather than throwing: a lexer edge case should only cost the feature built on this, not the
// render that already worked.
export const lexBlocks = (source: string): readonly MarkdownToken[] | undefined => {
    try {
        return marked.lexer(source);
    } catch {
        return undefined;
    }
};

// Inline tokens for one line, used by the surface that edits markdown as source and must tell markup from words.
// Lossless; guarded like `lexBlocks`.
export const lexInline = (source: string): readonly MarkdownToken[] | undefined => {
    try {
        return marked.Lexer.lexInline(source);
    } catch {
        return undefined;
    }
};

// Runs on the sanitized DOM before serializing, so app-specific rewrites (file-mention links) never re-admit markup
// from the source; a decorator may only author its own.
export type MarkdownDecorator = (fragment: DocumentFragment) => void;

// One prose run's sanitized HTML plus the code blocks its placeholders stand for; kept apart from substitution so
// a settled prefix parses once and still picks up later highlighting.
interface MarkdownParts {
    readonly html: string;
    readonly blocks: readonly CodeBlock[];
}

// Parse count since load, kept proportional to a message's block count rather than its frame count by the
// streaming split; renderMarkdown.test.ts asserts this. Exported only for that test.
let parses = 0;
export const markdownParseCount = (): number => parses;

// Elements that count as visible content on their own; anything else with no text renders as nothing (see
// `vanished`).
const SELF_SHOWING = `img, hr, svg, video, audio, canvas, input`;

// True when text went in but nothing visible came out (no text, code block, or self-showing element); a bare "4."
// parses as an empty list item. Caller then falls back to the escaped source.
const vanished = (holder: HTMLElement, text: string): boolean =>
    collected.length === 0 && text.trim() !== `` && (holder.textContent ?? ``).trim() === `` && holder.querySelector(SELF_SHOWING) === null;

// Never throws: a chat bubble re-runs this on every streamed delta, so any failure falls back to the escaped raw
// text. Sanitizes to a DOM fragment, not a string, so a decorator can rewrite it without a second parse.
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

// Swaps each placeholder for its real markup. Runs on every render, not cached with the parse, so a block picks up
// highlighting once it settles.
const substitute = (parts: MarkdownParts, colour: boolean): string =>
    parts.blocks.length === 0
        ? parts.html
        : parts.html.replace(CODE_PLACEHOLDER, (match, index: string) => {
              const at = Number(index);
              const block = parts.blocks[at];
              return block === undefined ? match : codeBlockHtml(block, at, colour);
          });

const asText = (source: string): string => (typeof source === `string` ? source : String(source ?? ``));

// Renders one prose run to an HTML string. The document-level API is built from this and is the only shape a
// figure fits in.
export const renderMarkdown = (source: string, decorate?: MarkdownDecorator): string => substitute(parseParts(asText(source), decorate), true);

// Documents render as a list of parts, prose already sanitized to HTML and figures as data, since a figure fence
// cannot sit inside an HTML string. A document without figures is just one part.
export type MarkdownPart = { readonly kind: "html"; readonly html: string } | { readonly kind: "figure"; readonly figure: Figure };

export type RenderedMarkdown = readonly MarkdownPart[];

// The parse, held between renders. Prose keeps its parsed parts rather than finished HTML because substitution
// reruns on every render (see `substitute`).
type ParsedPart = { readonly kind: "prose"; readonly parts: MarkdownParts } | { readonly kind: "figure"; readonly figure: Figure };

const parseDocument = (text: string, decorate: MarkdownDecorator | undefined): readonly ParsedPart[] =>
    splitFigureSegments(text).map((segment) =>
        segment.kind === `prose` ? { kind: `prose`, parts: parseParts(segment.text, decorate) } : { kind: `figure`, figure: segment.figure },
    );

// Figures pass through by identity so a streaming diagram is not redrawn, or re-imported, every frame. Empty prose
// runs are dropped rather than rendered as blank wrappers, since surfaces style the first/last block by position.
const renderDocument = (document: readonly ParsedPart[], colour: boolean): MarkdownPart[] =>
    document.flatMap((part): MarkdownPart[] => {
        if (part.kind === `figure`) {
            return [part];
        }
        const html = substitute(part.parts, colour);
        return html === `` ? [] : [{ kind: `html`, html }];
    });

// Whole-message render: every code block gets coloured and every closed figure fence gets drawn.
export const renderMarkdownParts = (source: string, decorate?: MarkdownDecorator): RenderedMarkdown =>
    renderDocument(parseDocument(asText(source), decorate), true);

// Streaming re-render splits the message at the last point provably finished: that prefix parses once and returns
// byte-identical HTML, so Vue skips patching it (preserving selection), and only the short tail is re-parsed.

// Opens or closes a code block; inside one, a blank line is content, not a block boundary.
const FENCE = /^ {0,3}(?:```|~~~)/;
// Matches a list item; a boundary is never taken between two of these, since splitting them restarts numbering and
// breaks a loose list.
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/;
// 4 spaces or a tab continues the block above; a boundary just before one would cut it in half.
const CONTINUATION = /^(?: {4}|\t)/;

// Last non-blank line ending at `end`, so the boundary check knows what the settled text left off with.
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

// Index up to which `text` is finished; scanning only from `from` (always a line start outside a fence) keeps the
// walk incremental. A blank line becomes a boundary only once the next line confirms it, so the line currently
// being typed never settles.
export const settledEnd = (text: string, from: number): number => {
    let settled = from;
    let inFence = false;
    let previous = lineBefore(text, from);
    // Index just past a blank line, held until the next non-blank line proves it's safe to cut there.
    let pending: number | undefined;
    let lineStart = from;
    for (let index = from; index <= text.length; index += 1) {
        if (index < text.length && text[index] !== `\n`) {
            continue;
        }
        const line = text.slice(lineStart, index);
        lineStart = index + 1;
        if (FENCE.test(line)) {
            // A fence line always starts a new block, so a pending boundary in front of it is safe to take; only an
            // opening
            // fence can have one pending here.
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

// One renderer per streaming message; the caller holds it for that message's lifetime.
export const createStreamingMarkdown = (decorate?: MarkdownDecorator): StreamingMarkdown => {
    let boundary = 0;
    let settledSource = ``;
    let settled: readonly ParsedPart[] = [];
    return {
        render: (source) => {
            const text = asText(source);
            // Not an append, a rewrite (an edited re-run, or the bubble reused for a new turn); start over.
            if (!text.startsWith(settledSource)) {
                boundary = 0;
                settledSource = ``;
                settled = [];
            }
            const next = settledEnd(text, boundary);
            if (next > boundary) {
                boundary = next;
                settledSource = text.slice(0, next);
                // Reparses the whole settled prefix, not just the new chunk, so blocks needing earlier context (list
                // continuation,
                // reference links) keep resolving.
                settled = parseDocument(settledSource, decorate);
            }
            // Tail renders as parts too, not one string, so a trailing diagram draws immediately instead of waiting for
            // text
            // after it; left uncoloured since it changes every frame.
            return [...renderDocument(settled, true), ...renderDocument(parseDocument(text.slice(boundary), decorate), false)];
        },
    };
};
