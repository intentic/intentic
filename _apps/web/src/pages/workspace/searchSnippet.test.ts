// @vitest-environment jsdom
import type { WorkspaceSearchHit } from "@intentic-app/api-contract";
import { useHighlighter } from "@intentic-app/ui";
import { expect, test, vi } from "vitest";
import { snippetPieces, snippetWindow } from "./searchSnippet";

// The @intentic-app/ui barrel that carries useHighlighter reaches window.matchMedia (useDevice) at import —
// hence jsdom plus the stub jsdom itself doesn't ship. Nothing under test touches the DOM.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

// Colour is asserted against the REAL TypeScript grammar — the point of going through Shiki is that the spans
// are the tokenizer's, so a hand-rolled fake would be testing nothing. tokenizeLine is what the component
// reaches (through the cache in snippetTokens, which only adds scheduling).
const tokensFor = (text: string, lang = `typescript`): Promise<readonly { content: string; offset: number }[]> =>
    useHighlighter()
        .tokenizeLine(text, lang)
        .then((tokens) => tokens ?? []);

const hit = (text: string, start?: number, end?: number): WorkspaceSearchHit => ({
    line: 12,
    text,
    tags: [],
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
});

const rendered = (pieces: readonly { text: string }[]): string => pieces.map((piece) => piece.text).join(``);
const marked = (pieces: readonly { text: string; hit: boolean }[]): string =>
    pieces
        .filter((piece) => piece.hit)
        .map((piece) => piece.text)
        .join(``);

test(`snippetWindow drops indentation and moves the offsets with it`, () => {
    const snippet = snippetWindow(hit(`        const test = 1;`, 14, 18));
    expect(snippet.text).toBe(`const test = 1;`);
    expect(snippet.text.slice(snippet.hitFrom, snippet.hitTo)).toBe(`test`);
    expect(snippet.elided).toBe(false);
});

test(`snippetWindow marks nothing when the daemon reported no offsets`, () => {
    // A semantic or definition hit matched the line, not a span of it.
    const snippet = snippetWindow(hit(`  const answer = compute();`));
    expect(snippet.text).toBe(`const answer = compute();`);
    expect(snippet.hitFrom).toBe(snippet.hitTo);
});

test(`snippetWindow cuts a far-right match into view and says so`, () => {
    const text = `${`x`.repeat(120)}needle after`;
    const snippet = snippetWindow(hit(text, 120, 126));
    expect(snippet.elided).toBe(true);
    // Only a short lead survives, so the match is inside the ~26 characters the default sidebar shows.
    expect(snippet.hitFrom).toBe(6);
    expect(snippet.text.slice(snippet.hitFrom, snippet.hitTo)).toBe(`needle`);
});

test(`snippetWindow keeps the line's own lead when the match is near the front`, () => {
    // 15 characters in, under the threshold: cutting here would cost the context that makes the row recognizable.
    const snippet = snippetWindow(hit(`    export const answer = 1;`, 17, 23));
    expect(snippet.elided).toBe(false);
    expect(snippet.text).toBe(`export const answer = 1;`);
    expect(snippet.text.slice(snippet.hitFrom, snippet.hitTo)).toBe(`answer`);
});

test(`snippetWindow bounds a minified line`, () => {
    const snippet = snippetWindow(hit(`a`.repeat(20_000), 4, 8));
    expect(snippet.text.length).toBe(240);
    expect(snippet.hitTo).toBe(8);
});

test(`snippetWindow clamps offsets that point past the line`, () => {
    // The hit's offsets and its text can come from either side of a file edit.
    const snippet = snippetWindow(hit(`short`, 40, 90));
    expect(snippet.hitFrom).toBe(5);
    expect(snippet.hitTo).toBe(5);
    expect(snippet.text).toBe(`short`);
});

test(`snippetPieces renders the whole snippet with no tokens, marking the match`, () => {
    const snippet = snippetWindow(hit(`  const test = 1;`, 8, 12));
    const pieces = snippetPieces(snippet, undefined);
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(marked(pieces)).toBe(`test`);
    expect(pieces.every((piece) => piece.style === undefined)).toBe(true);
});

test(`snippetPieces colours every piece and still marks exactly the match`, async () => {
    const snippet = snippetWindow(hit(`const test = 1;`, 6, 10));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    // Nothing lost or duplicated by the two-ruler merge, and the mark is the daemon's span to the character.
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(marked(pieces)).toBe(`test`);
    // `const` is a keyword and `test` an identifier, so the row is genuinely coloured, not uniformly styled.
    const colours = new Set(pieces.map((piece) => piece.style?.[`color`]));
    expect(colours.size).toBeGreaterThan(1);
    expect(colours.has(undefined)).toBe(false);
    // Dark mode is the same tokens read through a CSS var, so every piece must carry one.
    expect(pieces.every((piece) => piece.style?.[`--shiki-dark`] !== undefined)).toBe(true);
});

test(`snippetPieces splits a colour token that the match cuts through`, async () => {
    // The match covers `ompu`, inside the single identifier token `compute` — one token, three pieces, one colour.
    const snippet = snippetWindow(hit(`compute(1);`, 1, 5));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(pieces.slice(0, 3).map((piece) => [piece.text, piece.hit])).toEqual([
        [`c`, false],
        [`ompu`, true],
        [`te`, false],
    ]);
    expect(new Set(pieces.slice(0, 3).map((piece) => piece.style?.[`color`])).size).toBe(1);
});

test(`snippetPieces keeps a match spanning several colour tokens whole`, async () => {
    const snippet = snippetWindow(hit(`export const test = 1;`, 7, 17));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    // `const test` is a keyword plus an identifier — marked across the colour boundary, not merged over it.
    expect(marked(pieces)).toBe(`const test`);
    expect(pieces.filter((piece) => piece.hit).length).toBeGreaterThan(1);
});

test(`snippetPieces leaves an unmarked hit uncut`, async () => {
    const snippet = snippetWindow(hit(`const test = 1;`));
    const pieces = snippetPieces(snippet, await tokensFor(snippet.text));
    expect(rendered(pieces)).toBe(`const test = 1;`);
    expect(pieces.some((piece) => piece.hit)).toBe(false);
});
