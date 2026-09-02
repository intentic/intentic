import type * as Monaco from "monaco-editor-core";
import type { DiffOpen } from "../useLayout";
import { isBlank } from "@intentic/code-read";

/* WHICH HUNK A DIFF OPENS ON, one function per reading strategy behind one entry point (`landingChange`), so the
 * three settings useLayout.diffOpen offers are one table rather than three call sites in the viewer.
 *
 * A diff opens on its first change, and in most files that change is the import list: an added symbol, a moved
 * specifier, a path rewritten by a rename. It is real, it is never why the file was opened, and it costs the
 * reader a scroll on every file of every review. Knowing which lines are imports is what lets a diff land
 * below them instead (DiffView), and what keeps a wholesale import reorder from winning `biggest`. Nothing is
 * ever hidden: every strategy here only picks a scroll position.
 *
 * What counts as an import comes from codeAnalysis's shared TextMate walk, so one pass also produces the
 * comment-free model. This module only compares those locations with Monaco's finished hunks.
 *
 * The rule is the line's FIRST non-blank token: some grammars scope the whole statement (`meta.import.ts` spans a
 * multi-line import and its continuation lines with it), others only the keyword, and the lead token is the one
 * they agree on. It is also what keeps `const url = import.meta.url` and C#'s `using var x = f()` out, both
 * carry an import-ish scope somewhere, neither opens with one. */

// One side of a diff, as the hunk scan reads it: its lines as the pane holds them, and which of them are imports.
export type ImportSide = { lines: readonly string[]; imports: ReadonlySet<number> };

// What one side lost or gained in a hunk, each line paired with whether the scan called it an import. Monaco
// reports an `end` of 0 where the hunk doesn't touch this side at all, a pure insertion has no original lines.
const hunkLines = (side: ImportSide, start: number, end: number): { text: string; isImport: boolean }[] => {
    const lines: { text: string; isImport: boolean }[] = [];
    if (end === 0) {
        return lines; // untouched, and the start it pairs with is the line the change sits AFTER, not a line of it
    }
    for (let line = start; line <= end; line += 1) {
        lines.push({ text: side.lines[line - 1] ?? ``, isImport: side.imports.has(line) });
    }
    return lines;
};

// Both sides of one hunk, which is what every question below is asked of: a hunk is what it did to the file, and
// a run replaced line for line has half its evidence on the left.
const bothSides = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): { text: string; isImport: boolean }[] => [
    ...hunkLines(before, change.originalStartLineNumber, change.originalEndLineNumber),
    ...hunkLines(after, change.modifiedStartLineNumber, change.modifiedEndLineNumber),
];

// A hunk nobody opened the file for: every line it touched, on both sides, is an import or blank. One of them has
// to BE an import, so a hunk of pure blank-line churn still stops the scroll, this skips imports, not everything
// a reader might have found uninteresting.
const importsOnly = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): boolean => {
    const lines = bothSides(change, before, after);
    return lines.some((line) => line.isImport) && lines.every((line) => line.isImport || isBlank(line.text));
};

// How big a hunk reads as, for `biggest`: lines it touched on both sides, blanks not counted. Blanks are dropped
// for the same reason importsOnly forgives them: a block padded out with empty lines is not a bigger change than
// a dense one, and counting them lets whitespace churn out-measure the code it surrounds.
const changedLines = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): number =>
    bothSides(change, before, after).filter((line) => !isBlank(line.text)).length;

// Which hunk a diff should open on: the first that changes something other than an import, or, when every hunk
// is imports, the first of them, since the file then has nothing else to show. Undefined if nothing changed.
const firstChangeBeyondImports = (
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => changes.find((change) => !importsOnly(change, before, after)) ?? changes[0];

/* The file's heaviest block, which is the one a skim came for. Import-only hunks are not eligible at all (a
 * rename that rewrites forty import paths is the largest thing in the file and the least worth landing on),
 * and a file that is nothing BUT imports falls back to its first hunk exactly as above.
 *
 * TIES GO TO THE EARLIER HUNK, hence the strict `>`: two blocks of equal weight are equally good targets, and
 * the earlier one leaves less of the file behind the reader. */
const biggestChangeBeyondImports = (
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => {
    let biggest: Monaco.editor.ILineChange | undefined;
    let weight = -1;
    for (const change of changes) {
        if (importsOnly(change, before, after)) {
            continue;
        }
        const size = changedLines(change, before, after);
        if (size > weight) {
            biggest = change;
            weight = size;
        }
    }
    return biggest ?? changes[0];
};

// The reader's setting, resolved against one file's hunks. Undefined where there is nowhere to land, which for
// every strategy means the same thing: this diff has no changes in it.
export const landingChange = (
    open: DiffOpen,
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => {
    switch (open) {
        case `top`:
            return changes[0];
        case `imports`:
            return firstChangeBeyondImports(changes, before, after);
        case `biggest`:
            return biggestChangeBeyondImports(changes, before, after);
    }
};
