/* Save-time text normalization, the agent-convenience half of the write path. The coding agent's Edit tool is
 * exact-string matching against the bytes it last read, and its near-miss failures are almost always invisible
 * whitespace: trailing spaces, CRLF, a missing final newline. Normalizing every editor save keeps the files the
 * agent reads free of those, so its edits match on the first try instead of burning a failed call + re-read.
 *
 * Pure: computes Monaco-shaped edits (1-based line/column ranges) from the buffer's lines; CodeView applies them
 * via pushEditOperations so cursor position and the undo stack survive. EOL normalization (CRLF → LF) is NOT an
 * edit, the caller flips the model's EOL directly (model.setEOL), which Monaco applies without touching line
 * content. The canonical shape produced: no trailing spaces/tabs on any line (kept for markdown, where two
 * trailing spaces are a hard line break), no trailing blank lines, exactly one final newline. A whitespace-only
 * document normalizes to empty. */

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
    // One tail edit covers the last content line's trailing whitespace, any trailing blank lines, and the final
    // newline: replace everything after the kept content with exactly "\n". Skipped when that region already IS
    // a lone "\n" (the file ends `content\n`), so an already-canonical file produces zero edits.
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
