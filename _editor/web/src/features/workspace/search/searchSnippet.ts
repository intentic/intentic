import type { WorkspaceSearchHit, WorkspaceSearchSpan } from "@intentic/api-contract";
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref } from "vue";

// One search-result line ready to render: the visible slice cut into coloured pieces with the matched span flagged.
// Coloured via raw Shiki tokens merged with match spans here, not Shiki's HTML, since the two boundaries interleave.
// Highlighting is async; a miss renders plain, then re-renders via tokenVersion once colour lands.

// The visible slice of a hit line, and where its matches sit inside it.
export interface SnippetWindow {
    readonly text: string;
    // Offsets into `text`, in order; empty when a semantic/definition hit matched the whole line, not a span.
    readonly spans: readonly WorkspaceSearchSpan[];
    // Whether text was cut from the front to bring the match into view; shown as a leading ellipsis.
    readonly elided: boolean;
}

// One run of snippet text that is uniform in both rulers: same colour token, same side of the match.
export interface SnippetPiece {
    readonly text: string;
    // Shiki's dual-theme style (`color` + `--shiki-dark`); undefined while loading or unsupported.
    readonly style: Record<string, string> | undefined;
    readonly hit: boolean;
}

// Max characters rendered per line; bounds cost for a huge minified line and the tokenizer's input alike.
const MAX_TEXT = 240;
// Match past MAX_LEAD is pulled left to KEEP_BEFORE chars of lead, tuned to the sidebar's ~26-char width.
const MAX_LEAD = 16;
const KEEP_BEFORE = 6;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

// Builds what to render for one hit: offsets are into the whole line so they move with the cut, and are clamped
// since a stale hit can point past the given text. Keeps every span the line reported, not just the one that framed it.
export const snippetWindow = (hit: WorkspaceSearchHit): SnippetWindow => {
    // Browser may be newer than the daemon: missing `spans` means the line matched with no offsets, not nothing.
    const hitSpans = hit.spans ?? [];
    // Indentation is structure, not content; dropping it keeps a deeply nested match as dense as a top-level one.
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

// Cuts `snippet.text` at every colour boundary and every match edge. `tokens` must be Shiki's tokens for this exact
// text; without them the row falls back to a few uncoloured pieces.
export const snippetPieces = (snippet: SnippetWindow, tokens: readonly CodeToken[] | undefined): readonly SnippetPiece[] => {
    const pieces: SnippetPiece[] = [];
    const colours: readonly CodeToken[] = tokens ?? [{ content: snippet.text, offset: 0, htmlStyle: undefined }];
    for (const token of colours) {
        const to = token.offset + token.content.length;
        // Walks the token, alternating pre-match and match text; a match edge splits whichever token it lands in.
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

// `lang\ntext` → cached tokens (`[]` unsupported), LRU via Map order; must exceed one render's row count.
const CACHE_LIMIT = 600;
const cache = new Map<string, readonly CodeToken[]>();
const inFlight = new Set<string>();

// Bumped when tokens land; read on every call so a row that rendered uncoloured re-runs once ready.
const tokenVersion = ref(0);
// Whether anything in the current batch produced colour worth re-rendering for.
let landed = false;

// One bump per batch, not per line: waiting for the whole batch turns N re-renders into one. Per-line bumps would
// invalidate the computed on every landing, going quadratic in row count.
const settleBatch = (): void => {
    if (inFlight.size > 0 || !landed) {
        return;
    }
    landed = false;
    tokenVersion.value += 1;
};

// Returns cached colour tokens for this line, or undefined while scheduling the work for a later render.
export const snippetTokens = (text: string, lang: string | undefined): readonly CodeToken[] | undefined => {
    // Read unconditionally so a computed depends on it and re-runs once colour lands for a missed row.
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
                    // Grammar failed to load; leave uncached so a later render retries.
                    inFlight.delete(key);
                    settleBatch();
                },
            );
    }
    return undefined;
};
