// Save-time whitespace cleanup so the agent's exact-match Edit tool doesn't fail on invisible trailing spaces or a
// missing final newline. Canonical shape: no trailing blank lines, exactly one final newline; trimming trailing
// whitespace is skippable, since markdown treats two as a hard break.

export interface NormalizeEdit {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly text: string;
}

const TRAILING_WS = /[ \t]+$/u;

export const normalizationEdits = (lines: readonly string[], trimTrailingWhitespace: boolean): NormalizeEdit[] => {
    const trimmedLength = (line: string): number => (trimTrailingWhitespace ? line.replace(TRAILING_WS, ``).length : line.length);

    // Last line with real content, everything after it is the document tail to canonicalize.
    let last = lines.length;
    while (last > 0 && lines[last - 1]!.trim() === ``) {
        last--;
    }
    // Whitespace-only document: normalize to empty (one deleting edit, unless it already is empty).
    if (last === 0) {
        const lastLine = lines.at(-1)!;
        return lines.length === 1 && lastLine === ``
            ? []
            : [{ startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lastLine.length + 1, text: `` }];
    }

    const edits: NormalizeEdit[] = [];
    for (let i = 1; i < last; i++) {
        const line = lines[i - 1]!;
        const kept = trimmedLength(line);
        if (kept < line.length) {
            edits.push({ startLine: i, startColumn: kept + 1, endLine: i, endColumn: line.length + 1, text: `` });
        }
    }
    // One tail edit replaces everything after the kept content with a single newline; skipped if already canonical.
    const lastLine = lines[last - 1]!;
    const kept = trimmedLength(lastLine);
    const tail =
        lastLine.slice(kept) +
        lines
            .slice(last)
            .map((line) => `\n${line}`)
            .join(``);
    if (tail !== `\n`) {
        edits.push({ startLine: last, startColumn: kept + 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1, text: `\n` });
    }
    return edits;
};
