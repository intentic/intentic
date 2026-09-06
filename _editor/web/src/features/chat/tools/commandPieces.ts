import type { CommandSpan } from "@intentic/sandbox-contract";
import type { CodeToken } from "@intentic/ui";

/* ONE HELD COMMAND, CUT INTO THE PIECES A PERMISSION CARD PAINTS: two rulers laid over the same text, and the
 * boundaries of both.
 *
 * The FIRST ruler is Shiki's colouring, which is why the card is readable at all. A command that reaches this
 * card is regularly a hundred-plus characters of pipeline, and flat monospace is the shape in which a reader
 * cannot tell a path from a flag from a redirect without parsing it themselves.
 *
 * The SECOND is the gate's own `spans`: the fragments that put the command in the class that held it (the
 * daemon computes them where the rule fires, see command-classes.ts matchCommand). Those are the answer to the
 * one question the card must answer before any other, WHICH PART OF THIS stopped it, and colour alone cannot
 * say it: syntax highlighting is about grammar, and `.env` is coloured exactly like every other path.
 *
 * So the two are MERGED rather than layered. A mark boundary regularly falls inside a colour token (`@.env` is
 * one argument token; only four of its characters are the credential), so the token is cut there and both
 * halves keep the colour while only one keeps the mark. Exactly the merge pages/workspace/searchSnippet.ts does
 * for a search hit, for the same reason and with the same shape; the differences are that spans here are
 * offsets into a whole multi-line program rather than one line, and that both sides of the mark are rendered
 * (the search list only ever shows one line, this shows the whole command with the unmarked part dimmed).
 *
 * PURE, and per line. Tokenizing is asynchronous (grammars are dynamically imported) and rendering is not, so
 * the component owns the waiting and this owns the arithmetic; called with no tokens it returns the same
 * pieces uncoloured, which is what the card shows for the first frame and permanently for a program in a
 * language we ship no grammar for.
 */

// One run of the command that is uniform in both rulers: same colour token, same side of a mark.
export interface CommandPiece {
    readonly text: string;
    // Shiki's inline dual-theme style (a light `color` plus a `--shiki-dark` var), undefined while the grammar
    // loads and permanently for a language we ship none for.
    readonly style: Record<string, string> | undefined;
    // Inside one of the gate's spans: this is the fragment the card is holding the command for.
    readonly marked: boolean;
}

// One rendered line of the program, and where it started in the whole text, which is what lets a caller map a
// whole-program span onto it.
export interface CommandLine {
    readonly start: number;
    readonly text: string;
    readonly pieces: readonly CommandPiece[];
}

/* The program's lines with their offsets. Split on `\n` and keep the empty ones: a blank line inside a heredoc
 * is part of what would run, and dropping it would renumber every span after it.
 *
 * Lines rather than one blob because Shiki's `tokenizeLine` is a line at a time by design (a snippet lifted out
 * of its file carries no grammar state in from above it), and because the card wraps each line on its own. */
export const splitLines = (text: string): readonly { readonly text: string; readonly start: number }[] => {
    const lines: { text: string; start: number }[] = [];
    let start = 0;
    for (const line of text.split(`\n`)) {
        lines.push({ text: line, start });
        start += line.length + 1;
    }
    return lines;
};

/* One line's pieces. `tokens` are Shiki's for THAT line, so their offsets are into it; `spans` are the gate's,
 * so theirs are into the whole program and are rebased here.
 *
 * The walk is per token, alternating between what precedes the next mark and the mark itself: a mark edge cuts
 * whichever token it lands in, and the parts either side keep the colour and lose the mark. A span that does
 * not reach this line contributes nothing to it; one that spans several lines marks its slice of each. */
export const linePieces = (
    line: { readonly text: string; readonly start: number },
    spans: readonly CommandSpan[],
    tokens: readonly CodeToken[] | undefined,
): readonly CommandPiece[] => {
    const end = line.start + line.text.length;
    // Rebased onto this line and clipped to it, in order. Zero-width leftovers are dropped: a span that ends
    // exactly at a line break has nothing to paint on the next line.
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

// The whole program, ready to render. `tokens` is one entry per line, in order, or undefined for a program
// whose grammar has not landed (or does not exist), which renders plain and still marked, the marks are the
// gate's and do not depend on colour.
export const commandLines = (
    text: string,
    spans: readonly CommandSpan[],
    tokens: readonly (readonly CodeToken[] | undefined)[] | undefined,
): readonly CommandLine[] =>
    splitLines(text).map((line, index) => ({ ...line, pieces: linePieces(line, spans, tokens?.[index]) }));
