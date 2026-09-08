import type * as Monaco from "monaco-editor-core";
import type { DiffOpen } from "../../../shell/window/useLayout";
import { isBlank } from "@intentic/code-read";

// One function per useLayout.diffOpen strategy behind one entry point (landingChange): which hunk a diff opens
// on when its first change is usually just the import list. Import lines come from codeAnalysis's shared
// TextMate walk; the rule is the line's first non-blank token, which every grammar agrees on despite differing import
// scopes.

// One side of a diff, as the hunk scan reads it: its lines as the pane holds them, and which of them are imports.
export type ImportSide = { lines: readonly string[]; imports: ReadonlySet<number> };

// Lines one side lost or gained in a hunk, each paired with whether it's an import. Monaco's end of 0 means
// this side wasn't touched (a pure insertion has no original lines).
const hunkLines = (side: ImportSide, start: number, end: number): { text: string; isImport: boolean }[] => {
    const lines: { text: string; isImport: boolean }[] = [];
    if (end === 0) {
        return lines; // Untouched; the start it pairs with is the line the change sits after, not a line of it.
    }
    for (let line = start; line <= end; line += 1) {
        lines.push({ text: side.lines[line - 1] ?? ``, isImport: side.imports.has(line) });
    }
    return lines;
};

// Both sides of a hunk, since every question below needs both; a straight line-for-line replace has half its
// evidence on the left.
const bothSides = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): { text: string; isImport: boolean }[] => [
    ...hunkLines(before, change.originalStartLineNumber, change.originalEndLineNumber),
    ...hunkLines(after, change.modifiedStartLineNumber, change.modifiedEndLineNumber),
];

// True when every line the hunk touched is an import or blank, and at least one is an import; blank-only churn
// still stops the scroll. Skips only imports, not everything uninteresting.
const importsOnly = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): boolean => {
    const lines = bothSides(change, before, after);
    return lines.some((line) => line.isImport) && lines.every((line) => line.isImport || isBlank(line.text));
};

// Size of a hunk for `biggest`; blanks aren't counted, so a block padded with empty lines can't outweigh a dense one.
const changedLines = (change: Monaco.editor.ILineChange, before: ImportSide, after: ImportSide): number =>
    bothSides(change, before, after).filter((line) => !isBlank(line.text)).length;

// First hunk that changes more than imports, falling back to the first hunk when every one is imports (or
// undefined when there are none).
const firstChangeBeyondImports = (
    changes: readonly Monaco.editor.ILineChange[],
    before: ImportSide,
    after: ImportSide,
): Monaco.editor.ILineChange | undefined => changes.find((change) => !importsOnly(change, before, after)) ?? changes[0];

// Heaviest hunk that isn't import-only (an all-import rename wins nothing); falls back to the first hunk if
// every one is imports. Ties keep the earlier hunk (strict `>`), leaving less of the file behind.
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

// Resolves the reader's diffOpen setting against one file's hunks. Undefined only means the diff has no
// changes at all.
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
