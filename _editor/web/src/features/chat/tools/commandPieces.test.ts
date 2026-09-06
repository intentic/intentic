import type { CodeToken } from "@intentic/ui";
import { describe, expect, it } from "vitest";
import { commandLines, linePieces, splitLines } from "./commandPieces.js";

// A stand-in for Shiki's output: the colour boundaries, without loading a grammar in a unit test. `htmlStyle`
// is opaque to the merge, so any distinguishable value proves it survives the cut.
const tokensFor = (line: string, cuts: readonly number[]): CodeToken[] => {
    const bounds = [0, ...cuts, line.length];
    return bounds.slice(0, -1).map((start, index) => ({
        content: line.slice(start, bounds[index + 1]),
        offset: start,
        htmlStyle: { color: `c${index}` },
    }));
};

const texts = (pieces: readonly { readonly text: string }[]): string[] => pieces.map((piece) => piece.text);
const markedText = (pieces: readonly { readonly text: string; readonly marked: boolean }[]): string[] =>
    pieces.filter((piece) => piece.marked).map((piece) => piece.text);

describe(`splitLines`, () => {
    it(`keeps every line, empty ones included, with the offsets the spans are measured against`, () => {
        expect(splitLines(`a\n\nbc`)).toEqual([
            { text: `a`, start: 0 },
            { text: ``, start: 2 },
            { text: `bc`, start: 3 },
        ]);
    });
});

describe(`linePieces`, () => {
    const line = { text: `cat .env now`, start: 0 };

    // With no grammar loaded the card still marks: the marks are the gate's and do not depend on colour.
    it(`marks without colour`, () => {
        const pieces = linePieces(line, [{ start: 4, end: 8 }], undefined);
        expect(texts(pieces)).toEqual([`cat `, `.env`, ` now`]);
        expect(markedText(pieces)).toEqual([`.env`]);
        expect(pieces.every((piece) => piece.style === undefined)).toBe(true);
    });

    /* THE MERGE ITSELF: a mark boundary inside a colour token cuts the token, and BOTH halves keep the colour
     * while only one keeps the mark. Getting this wrong is how `@.env` comes out either uncoloured or marked
     * whole, and the second is a card pointing at an argument rather than at a credential. */
    it(`cuts a colour token at a mark edge and keeps the colour on both sides`, () => {
        // One token over the whole line, so any cut here has to come from the mark.
        const pieces = linePieces(line, [{ start: 4, end: 8 }], tokensFor(line.text, []));
        expect(texts(pieces)).toEqual([`cat `, `.env`, ` now`]);
        expect(pieces.map((piece) => piece.style)).toEqual([{ color: `c0` }, { color: `c0` }, { color: `c0` }]);
        expect(markedText(pieces)).toEqual([`.env`]);
    });

    it(`cuts at colour boundaries too, so a mark spanning two tokens keeps each one's colour`, () => {
        const pieces = linePieces(line, [{ start: 0, end: 8 }], tokensFor(line.text, [4]));
        expect(texts(pieces)).toEqual([`cat `, `.env`, ` now`]);
        expect(markedText(pieces)).toEqual([`cat `, `.env`]);
        expect(pieces[0]?.style).toEqual({ color: `c0` });
        expect(pieces[1]?.style).toEqual({ color: `c1` });
    });

    it(`marks every span on the line, not just the first`, () => {
        const two = { text: `cat .env .npmrc`, start: 0 };
        const pieces = linePieces(two, [{ start: 4, end: 8 }, { start: 9, end: 15 }], undefined);
        expect(markedText(pieces)).toEqual([`.env`, `.npmrc`]);
        expect(texts(pieces).join(``)).toBe(two.text);
    });

    // Spans are offsets into the WHOLE program; a line renders its own slice of them and nothing else.
    it(`rebases whole-program spans onto the line, and ignores the ones that miss it`, () => {
        const second = { text: `cat .env`, start: 9 };
        expect(markedText(linePieces(second, [{ start: 13, end: 17 }], undefined))).toEqual([`.env`]);
        expect(markedText(linePieces(second, [{ start: 0, end: 4 }], undefined))).toEqual([]);
    });

    it(`marks its slice of a span that runs across a line break`, () => {
        const first = { text: `rm -rf \\`, start: 0 };
        const second = { text: `  /work`, start: 9 };
        const span = [{ start: 0, end: 16 }];
        expect(markedText(linePieces(first, span, undefined))).toEqual([`rm -rf \\`]);
        expect(markedText(linePieces(second, span, undefined))).toEqual([`  /work`]);
    });

    // Whatever the cuts, the pieces must reassemble into exactly the line: a merge that drops or duplicates a
    // character is a card showing a command that is not the one about to run.
    it(`always reassembles into the original line`, () => {
        for (const spans of [[], [{ start: 0, end: 12 }], [{ start: 4, end: 8 }], [{ start: 3, end: 5 }, { start: 7, end: 9 }]]) {
            for (const cuts of [[], [4], [3, 8], [1, 4, 8, 11]]) {
                expect(texts(linePieces(line, spans, tokensFor(line.text, cuts))).join(``), JSON.stringify({ spans, cuts })).toBe(line.text);
            }
        }
    });
});

describe(`commandLines`, () => {
    it(`lines up one token list per line and marks across the whole program`, () => {
        const text = `cd /work\ncat .env`;
        const lines = commandLines(text, [{ start: 13, end: 17 }], [tokensFor(`cd /work`, [3]), tokensFor(`cat .env`, [4])]);
        expect(lines.map((line) => line.text)).toEqual([`cd /work`, `cat .env`]);
        expect(markedText(lines[0]!.pieces)).toEqual([]);
        expect(markedText(lines[1]!.pieces)).toEqual([`.env`]);
    });

    it(`renders plain when no grammar has landed`, () => {
        const lines = commandLines(`cat .env`, [{ start: 4, end: 8 }], undefined);
        expect(markedText(lines[0]!.pieces)).toEqual([`.env`]);
    });
});
