import { describe, expect, it } from "vitest";
import { normalizationEdits, type NormalizeEdit } from "./normalizeOnSave";

/* Save-time normalization exists for the agent: its exact-string edits fail on invisible whitespace, so every
 * saved file must land in ONE canonical shape: no trailing spaces (markdown excepted), no trailing blank
 * lines, exactly one final newline. These tests pin that shape by applying the computed edits to real text. */

// Apply Monaco-shaped 1-based line/column edits to plain text: the reference implementation the edits are
// checked against. Applied last-to-first so earlier ranges stay valid (the edits are emitted sorted ascending).
const apply = (text: string, edits: readonly NormalizeEdit[]): string => {
    const lines = text.split(`\n`);
    const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column - 1;
    let result = text;
    for (const edit of edits.toReversed()) {
        result = result.slice(0, offset(edit.startLine, edit.startColumn)) + edit.text + result.slice(offset(edit.endLine, edit.endColumn));
    }
    return result;
};

const normalize = (text: string, trimTrailingWhitespace = true): string => apply(text, normalizationEdits(text.split(`\n`), trimTrailingWhitespace));

describe(`normalizationEdits`, () => {
    it(`strips trailing whitespace from every line`, () => {
        expect(normalize(`const a = 1;  \n\tconst b = 2;\t\n`)).toBe(`const a = 1;\n\tconst b = 2;\n`);
    });

    it(`adds the missing final newline`, () => {
        expect(normalize(`const a = 1;`)).toBe(`const a = 1;\n`);
    });

    it(`collapses trailing blank lines (including whitespace-only ones) to one final newline`, () => {
        expect(normalize(`done\n\n\n`)).toBe(`done\n`);
        expect(normalize(`done  \n  \n\t\n`)).toBe(`done\n`);
    });

    it(`returns zero edits for an already-canonical document`, () => {
        expect(normalizationEdits([`const a = 1;`, ``], true)).toEqual([]);
        expect(normalizationEdits([``], true)).toEqual([]);
    });

    it(`normalizes a whitespace-only document to empty`, () => {
        expect(normalize(`  \n\t\n`)).toBe(``);
        expect(normalize(`   `)).toBe(``);
    });

    it(`keeps interior blank lines and interior structure untouched`, () => {
        expect(normalize(`a\n\nb\n`)).toBe(`a\n\nb\n`);
    });

    it(`preserves trailing spaces for markdown (hard line breaks) while still fixing the tail`, () => {
        expect(normalize(`line one  \nline two\n\n\n`, false)).toBe(`line one  \nline two\n`);
        // Even the last content line keeps its trailing spaces in markdown.
        expect(normalize(`line one  `, false)).toBe(`line one  \n`);
    });

    it(`fixes trailing whitespace on the last content line together with the tail`, () => {
        expect(normalize(`const a = 1;  `)).toBe(`const a = 1;\n`);
        expect(normalize(`const a = 1;  \n\n`)).toBe(`const a = 1;\n`);
    });
});
