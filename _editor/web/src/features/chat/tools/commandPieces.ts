import type { CommandSpan } from "@intentic/sandbox-contract";
import type { CodeToken } from "@intentic/ui";

// One held command cut into the pieces a permission card paints: Shiki's colour merged with the gate's own
// `spans`, since colour alone can't say which fragment stopped it. A mark boundary cuts through whichever
// colour token it falls in, so each half keeps its colour and only one keeps the mark. Pure; called with no
// tokens it returns the same pieces uncoloured.

// One run of the command uniform in both rulers: same colour token, same side of a mark.
export interface CommandPiece {
    readonly text: string;
    // Shiki's inline dual-theme style, undefined while the grammar loads or for a language none ships.
    readonly style: Record<string, string> | undefined;
    // Inside one of the gate's spans: the fragment the card is holding the command for.
    readonly marked: boolean;
}

// One rendered line with where it started in the whole text, so a caller can map a whole-program span onto it.
export interface CommandLine {
    readonly start: number;
    readonly text: string;
    readonly pieces: readonly CommandPiece[];
}

// Lines with their offsets, keeping empty ones (a blank heredoc line still counts; dropping it would renumber
// later spans). Per-line since Shiki tokenizes a line at a time and the card wraps each line on its own.
export const splitLines = (text: string): readonly { readonly text: string; readonly start: number }[] => {
    const lines: { text: string; start: number }[] = [];
    let start = 0;
    for (const line of text.split(`\n`)) {
        lines.push({ text: line, start });
        start += line.length + 1;
    }
    return lines;
};

// `tokens` are Shiki's, offset into this line; `spans` are the gate's, rebased from the whole program. Walks
// token by token, cutting whichever one a mark edge lands in so both halves keep colour and only the marked one
// keeps the mark.
export const linePieces = (
    line: { readonly text: string; readonly start: number },
    spans: readonly CommandSpan[],
    tokens: readonly CodeToken[] | undefined,
): readonly CommandPiece[] => {
    const end = line.start + line.text.length;
    // Rebased onto this line and clipped to it; a span ending exactly at a line break is dropped as zero-width.
    const local = spans
        .filter((span) => span.start < end && span.end > line.start)
        .map((span) => ({ start: Math.max(0, span.start - line.start), end: Math.min(line.text.length, span.end - line.start) }))
        .filter((span) => span.end > span.start);
    const pieces: CommandPiece[] = [];
    const colours: readonly CodeToken[] = tokens ?? [{ content: line.text, offset: 0, htmlStyle: undefined }];
    for (const token of colours) {
        const to = token.offset + token.content.length;
        let at = token.offset;
        for (const span of local) {
            if (span.end <= at || span.start >= to) {
                continue;
            }
            const marked = { from: Math.max(at, span.start), to: Math.min(to, span.end) };
            if (marked.from > at) {
                pieces.push({ text: line.text.slice(at, marked.from), style: token.htmlStyle, marked: false });
            }
            pieces.push({ text: line.text.slice(marked.from, marked.to), style: token.htmlStyle, marked: true });
            at = marked.to;
        }
        if (to > at) {
            pieces.push({ text: line.text.slice(at, to), style: token.htmlStyle, marked: false });
        }
    }
    return pieces;
};

// `tokens` is one entry per line, or undefined for a program with no grammar (yet or ever), which renders
// plain but still marked — marks don't depend on colour.
export const commandLines = (
    text: string,
    spans: readonly CommandSpan[],
    tokens: readonly (readonly CodeToken[] | undefined)[] | undefined,
): readonly CommandLine[] =>
    splitLines(text).map((line, index) => ({ ...line, pieces: linePieces(line, spans, tokens?.[index]) }));
