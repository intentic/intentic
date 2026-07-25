import DOMPurify from "dompurify";
import { marked } from "marked";

/* Render untrusted markdown (workspace files, agent chat output) to SANITIZED HTML for v-html. Vue's v-html
 * does NOT sanitize, so we must do it ourselves — marked passes inline HTML through, so without this a
 * workspace file or a crafted agent turn could inject <script>/onerror. DOMPurify strips the active markup
 * while keeping the prose. */

// Minimal HTML escape for the fallback path — enough to render arbitrary text inertly inside v-html.
const escapeHtml = (text: string): string => text.replace(/&/g, `&amp;`).replace(/</g, `&lt;`).replace(/>/g, `&gt;`).replace(/"/g, `&quot;`);

// Never let a markdown/sanitizer edge case (or a non-string slipping in mid-stream) crash the surrounding
// component — a chat bubble re-renders this on every streamed delta, so a single throw would blank the turn.
// On any failure, fall back to the raw text, HTML-escaped, so the content still shows (just unstyled).
export const renderMarkdown = (source: string): string => {
    const text = typeof source === `string` ? source : String(source ?? ``);
    try {
        return DOMPurify.sanitize(marked.parse(text, { async: false }));
    } catch {
        return escapeHtml(text);
    }
};

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
    for (let stop = end; stop > 0; ) {
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
    // `settled` is stable across frames for a given prefix; `tail` is the part still being written.
    readonly render: (source: string) => { readonly settled: string; readonly tail: string };
}

// One renderer per streaming message (the caller holds it for the message's lifetime).
export const createStreamingMarkdown = (): StreamingMarkdown => {
    let boundary = 0;
    let settledSource = ``;
    let settledHtml = ``;
    return {
        render: (source) => {
            const text = typeof source === `string` ? source : String(source ?? ``);
            // Not an append but a rewrite (an edited re-run, a bubble reused for a new turn) — start over.
            if (!text.startsWith(settledSource)) {
                boundary = 0;
                settledSource = ``;
                settledHtml = ``;
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
                settledHtml = renderMarkdown(settledSource);
            }
            return { settled: settledHtml, tail: renderMarkdown(text.slice(boundary)) };
        },
    };
};
