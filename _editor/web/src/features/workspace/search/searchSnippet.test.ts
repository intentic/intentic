// @vitest-environment jsdom
import type { WorkspaceSearchHit } from "@intentic/api-contract";
import { useHighlighter } from "@intentic/ui";
import { expect, test } from "vitest";
import { snippetPieces, snippetWindow } from "./searchSnippet";

// Needs jsdom: the @intentic/ui barrel (useHighlighter) touches window.matchMedia at import. Nothing under test
// touches the DOM.

// Colours asserted against the real TypeScript grammar via Shiki's tokenizeLine, the same call snippetTokens' cache
// wraps.
const tokensFor = (text: string, lang = `typescript`): Promise<readonly { content: string; offset: number }[]> =>
    useHighlighter()
        .tokenizeLine(text, lang)
        .then((tokens) => tokens ?? []);

const hit = (text: string, ...spans: readonly (readonly [number, number])[]): WorkspaceSearchHit => ({
    line: 12,
    text,
    tags: [],
    spans: spans.map(([start, end]) => ({ start, end })),
});

// What the row shows as marked, span by span.
const spanTexts = (snippet: { text: string; spans: readonly { start: number; end: number }[] }): string[] =>
    snippet.spans.map((span) => snippet.text.slice(span.start, span.end));

const rendered = (pieces: readonly { text: string }[]): string => pieces.map((piece) => piece.text).join(``);
const marked = (pieces: readonly { text: string; hit: boolean }[]): string =>
    pieces
        .filter((piece) => piece.hit)
        .map((piece) => piece.text)
        .join(``);

test(`snippetWindow drops indentation and moves the offsets with it`, () => {
    const snippet = snippetWindow(hit(`        const test = 1;`, [14, 18]));
    expect(snippet.text).toBe(`const test = 1;`);
    expect(spanTexts(snippet)).toEqual([`test`]);
    expect(snippet.elided).toBe(false);
});

test(`snippetWindow keeps every occurrence on the line`, () => {
    const snippet = snippetWindow(hit(`  own its own sandbox`, [2, 5], [10, 13]));
    expect(snippet.text).toBe(`own its own sandbox`);
    expect(spanTexts(snippet)).toEqual([`own`, `own`]);
});

test(`snippetWindow marks nothing when the daemon reported no offsets`, () => {
    const snippet = snippetWindow(hit(`  const answer = compute();`));
    expect(snippet.text).toBe(`const answer = compute();`);
    expect(snippet.spans).toEqual([]);
});

test(`snippetWindow cuts a far-right match into view and says so`, () => {
    const text = `${`x`.repeat(120)}needle after`;
    const snippet = snippetWindow(hit(text, [120, 126]));
    expect(snippet.elided).toBe(true);
    expect(snippet.spans[0]?.start).toBe(6);
    expect(spanTexts(snippet)).toEqual([`needle`]);
});

test(`snippetWindow keeps the line's own lead when the match is near the front`, () => {
    // Offset chosen just under the elision threshold, so the lead survives uncut.
    const snippet = snippetWindow(hit(`    export const answer = 1;`, [17, 23]));
    expect(snippet.elided).toBe(false);
    expect(snippet.text).toBe(`export const answer = 1;`);
    expect(spanTexts(snippet)).toEqual([`answer`]);
});

test(`snippetWindow bounds a minified line`, () => {
    const snippet = snippetWindow(hit(`a`.repeat(20_000), [4, 8]));
    expect(snippet.text.length).toBe(240);
    expect(snippet.spans).toEqual([{ start: 4, end: 8 }]);
});

test(`snippetWindow drops offsets that point past the line`, () => {
    // Offsets can be stale relative to the text after an edit; an empty span beats marking the wrong characters.
    const snippet = snippetWindow(hit(`short`, [40, 90]));
    expect(snippet.spans).toEqual([]);
    expect(snippet.text).toBe(`short`);
});

test(`snippetPieces renders the whole snippet with no tokens, marking the match`, () => {
    const snippet = snippetWindow(hit(`  const test = 1;`, [8, 12]));
    const pieces = snippetPieces(snippet, undefined);
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(marked(pieces)).toBe(`test`);
    expect(pieces.every((piece) => piece.style === undefined)).toBe(true);
});

test(`snippetPieces colours every piece and still marks exactly the match`, async () => {
    const snippet = snippetWindow(hit(`const test = 1;`, [6, 10]));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(marked(pieces)).toBe(`test`);
    // `const` and `test` differ in kind, so distinct colours here mean real tokenization, not a uniform style.
    const colours = new Set(pieces.map((piece) => piece.style?.[`color`]));
    expect(colours.size).toBeGreaterThan(1);
    expect(colours.has(undefined)).toBe(false);
    // Dark mode reads the same tokens through a CSS var; every piece must carry one.
    expect(pieces.every((piece) => piece.style?.[`--shiki-dark`] !== undefined)).toBe(true);
});

test(`snippetPieces splits a colour token that the match cuts through`, async () => {
    // Match covers `ompu` inside token `compute`: one token becomes three pieces, one colour.
    const snippet = snippetWindow(hit(`compute(1);`, [1, 5]));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(pieces.slice(0, 3).map((piece) => [piece.text, piece.hit])).toEqual([
        [`c`, false],
        [`ompu`, true],
        [`te`, false],
    ]);
    expect(new Set(pieces.slice(0, 3).map((piece) => piece.style?.[`color`])).size).toBe(1);
});

test(`snippetPieces keeps a match spanning several colour tokens whole`, async () => {
    const snippet = snippetWindow(hit(`export const test = 1;`, [7, 17]));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    // `const test` spans a keyword/identifier boundary; the mark crosses it without merging colours.
    expect(marked(pieces)).toBe(`const test`);
    expect(pieces.filter((piece) => piece.hit).length).toBeGreaterThan(1);
});

test(`snippetPieces marks every occurrence, each cut out of its own colour token`, async () => {
    // Two `own` matches in one line, one inside a single identifier token; both marked, colours intact.
    const snippet = snippetWindow(hit(`const own = own + 1;`, [6, 9], [12, 15]));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(rendered(pieces)).toBe(`const own = own + 1;`);
    expect(pieces.filter((piece) => piece.hit).map((piece) => piece.text)).toEqual([`own`, `own`]);
});

test(`snippetPieces leaves an unmarked hit uncut`, async () => {
    const snippet = snippetWindow(hit(`const test = 1;`));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(pieces.some((piece) => piece.hit)).toBe(false);
});
