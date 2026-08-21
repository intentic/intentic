import type * as Monaco from "monaco-editor-core";
import { isBlank } from "./codeTokens";

/* Which part of a diff lies beyond its imports, the target useLayout.skipImports scrolls to.
 *
 * A diff opens on its first change, and in most files that change is the import list: an added symbol, a moved
 * specifier, a path rewritten by a rename. It is real, it is never why the file was opened, and it costs the
 * reader a scroll on every file of every review. Knowing which lines are imports is what lets the diff land
 * below them instead (DiffView), the lines are still there to scroll up to, nothing is hidden.
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

// A hunk nobody opened the file for: every line it touched, on both sides, is an import or blank. One of them has
// to BE an import, so a hunk of pure blank-line churn still stops the scroll, this skips imports, not everything
// a reader might have found uninteresting.
const importsOnly = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): boolean => {
    const lines = [
        ...hunkLines(before, change.originalStartLineNumber, change.originalEndLineNumber),
        ...hunkLines(after, change.modifiedStartLineNumber, change.modifiedEndLineNumber),
    ];
    return lines.some((line) => line.isImport) && lines.every((line) => line.isImport || isBlank(line.text));
};

// Which hunk a diff should open on: the first that changes something other than an import, or, when every hunk
// is imports, the first of them, since the file then has nothing else to show. Undefined if nothing changed.
export const firstChangeBeyondImports = (
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => changes.find((change) => !importsOnly(change, before, after)) ?? changes[0];
