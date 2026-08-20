import type { WorkspaceSearchHit, WorkspaceSearchSpan } from "@intentic-app/api-contract";
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref } from "vue";

/* One content-search result line, ready to render: the slice of the line worth showing, cut into coloured
 * pieces with the matched span flagged.
 *
 * Colour, because the match list was the one place in the app where code rendered with none, a few hundred
 * rows of flat monospace, in which the only thing a reader could pick out was the mark. It cannot come from
 * Shiki's HTML the way every other code surface here does: the match highlight has to be INTERLEAVED with the
 * colour spans, so the tokens arrive raw (useHighlighter.tokenizeLine) and the two rulers, colour boundaries
 * and match boundaries, are merged here.
 *
 * Framing, because a match at column 120 rendered off the right edge of the sidebar, which is the one thing
 * the row exists to show. A far-right match brings a little of its own context and the cut is marked.
 *
 * Highlighting is asynchronous (grammars are dynamically imported) while rendering is synchronous, so a miss
 * renders plain and schedules the work; `tokenVersion` then invalidates the computed that read it and the
 * re-render hits the cache. Same shape, and the same reasons, as the markdown engine's code blocks
 * (ui/markdown/code.ts). */

// The visible slice of a hit line, and where its matches sit inside it.
export interface SnippetWindow {
    readonly text: string;
    // Offsets into `text`, in order. Empty when there is nothing to mark, a semantic or definition hit matched
    // the LINE rather than a span of it, and reports no offsets.
    readonly spans: readonly WorkspaceSearchSpan[];
    // Whether text was cut off the FRONT to bring the match into view, which the row shows as a leading ellipsis.
    readonly elided: boolean;
}

// One run of snippet text that is uniform in both rulers: same colour token, same side of the match.
export interface SnippetPiece {
    readonly text: string;
    // Shiki's inline dual-theme style (light `color` plus a `--shiki-dark` var), undefined while the grammar
    // loads and permanently for a language we ship none for.
    readonly style: Record<string, string> | undefined;
    readonly hit: boolean;
}

/* Characters of the line rendered at most, far more than the widest sidebar shows, since CSS truncates what
 * doesn't fit. It is here so a minified 200 KB line costs a bounded text node per row instead of its whole
 * length, and so the tokenizer's input is bounded with it. */
const MAX_TEXT = 240;
/* A match further into the line than this is pulled left until only KEEP_BEFORE characters precede it. Both are
 * tuned to the sidebar's DEFAULT width (256px, useLayout), where a snippet row fits about 26 characters, the
 * width at which this has to work, since it is the one nobody chose. Under the threshold the line keeps its own
 * lead, which is what makes a row recognizable (`export const`, `test(`, `function`); over it, the match's first
 * characters are what matter, and they are always inside those 26. */
const MAX_LEAD = 16;
const KEEP_BEFORE = 6;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

// What to render for one hit. The daemon's offsets are into the whole line, so they move with the cut; each is
// clamped, since a hit whose offsets predate a file edit can point past the text we were given. Every span the
// line reported is kept: a search marks all of a line's occurrences, not just the one that framed it.
export const snippetWindow = (hit: WorkspaceSearchHit): SnippetWindow => {
    // This browser can be NEWER than the daemon it is talking to (the app ships ahead of the sandbox image, see
    // sandboxClient's 404 note), and `spans` postdates the first version of this route. An answer without them
    // means what a semantic hit's empty one means, the line matched, no offsets, rather than a blank panel.
    const hitSpans = hit.spans ?? [];
    // Indentation is structure, not content: dropping it is what lets a deeply nested match read at the same
    // density as a top-level one.
    const indent = hit.text.length - hit.text.trimStart().length;
    const first = clamp(hitSpans[0]?.start ?? indent, indent, hit.text.length);
    const elided = first - indent > MAX_LEAD;
    const cut = elided ? first - KEEP_BEFORE : indent;
    const text = hit.text.slice(cut, cut + MAX_TEXT);
    const spans = hitSpans
        .map((span) => ({ start: clamp(span.start - cut, 0, text.length), end: clamp(span.end - cut, 0, text.length) }))
        .filter((span) => span.end > span.start);
    return { text, spans, elided };
};

// `snippet.text` cut at every colour boundary and at every match edge. `tokens` are Shiki's for that exact text,
// so their offsets are into it; without them the row comes out as a handful of uncoloured pieces, which is what
// it looked like before colour.
export const snippetPieces = (snippet: SnippetWindow, tokens: readonly CodeToken[] | undefined): readonly SnippetPiece[] => {
    const pieces: SnippetPiece[] = [];
    const colours: readonly CodeToken[] = tokens ?? [{ content: snippet.text, offset: 0, htmlStyle: undefined }];
    for (const token of colours) {
        const to = token.offset + token.content.length;
        // Walk the token, alternating between what precedes the next match and the match itself: a match edge
        // cuts through whichever token it lands in, and the parts either side keep the colour and lose the mark.
        let at = token.offset;
        for (const span of snippet.spans) {
            if (span.end <= at || span.start >= to) {
                continue;
            }
            const marked = { from: Math.max(at, span.start), to: Math.min(to, span.end) };
            if (marked.from > at) {
                pieces.push({ text: snippet.text.slice(at, marked.from), style: token.htmlStyle, hit: false });
            }
            pieces.push({ text: snippet.text.slice(marked.from, marked.to), style: token.htmlStyle, hit: true });
            at = marked.to;
        }
        if (to > at) {
            pieces.push({ text: snippet.text.slice(at, to), style: token.htmlStyle, hit: false });
        }
    }
    return pieces;
};

/* `lang\ntext` → that line's tokens, `[]` for a language we don't ship (remembered so it is attempted once).
 * Recency-ordered via Map insertion order, so the cap evicts the least recently used.
 *
 * The size has to stay well above what ONE RENDER can ask for, and that is what makes the results panel's
 * windowing functional rather than cosmetic. When the panel asked for every row of a result set at once, a
 * set larger than this cache could not fit in it, so each batch evicted rows the same batch had just coloured,
 * the invalidation re-rendered them, and they were requested again, forever, on the main thread. A window is
 * a few dozen lines; a few hundred entries hold many screenfuls of scrollback, so nothing evicts under it. */
const CACHE_LIMIT = 600;
const cache = new Map<string, readonly CodeToken[]>();
const inFlight = new Set<string>();

// Bumped when tokens land. Read on every call (see below) so the computed that rendered a not-yet-coloured row
// re-runs once its colour is ready.
const tokenVersion = ref(0);
// Whether anything in the current batch produced colour worth re-rendering for.
let landed = false;

/* One bump per BATCH, not per line: a result list's rows are all scheduled by the same render, so waiting for
 * the last of them turns N re-renders of the whole list into one. Per-line bumps are the storm, each landing
 * invalidates the computed, which walks every row again, and the cost goes quadratic in the row count. */
const settleBatch = (): void => {
    if (inFlight.size > 0 || !landed) {
        return;
    }
    landed = false;
    tokenVersion.value += 1;
};

// This line's colour tokens if they are already in the cache, otherwise undefined, scheduling the work so a
// later render can have them.
export const snippetTokens = (text: string, lang: string | undefined): readonly CodeToken[] | undefined => {
    // Read unconditionally: a row that misses today must re-render when its colour lands, and a computed only
    // re-runs on a dependency it actually read.
    void tokenVersion.value;
    if (lang === undefined) {
        return undefined;
    }
    const key = `${lang}\n${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        return hit.length === 0 ? undefined : hit;
    }
    if (!inFlight.has(key)) {
        inFlight.add(key);
        void useHighlighter()
            .tokenizeLine(text, lang)
            .then(
                (tokens) => {
                    inFlight.delete(key);
                    cache.set(key, tokens ?? []);
                    if (cache.size > CACHE_LIMIT) {
                        const oldest = cache.keys().next().value;
                        if (oldest !== undefined) {
                            cache.delete(oldest);
                        }
                    }
                    // A language we don't ship changes nothing on screen, don't invalidate for it.
                    landed ||= tokens !== undefined;
                    settleBatch();
                },
                () => {
                    // Grammar chunk failed to load (offline, or a dev optimizer miss). Leave it uncached so a
                    // later render retries.
                    inFlight.delete(key);
                    settleBatch();
                },
            );
    }
    return undefined;
};
