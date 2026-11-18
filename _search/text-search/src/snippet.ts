import type { WorkspaceSearchSpan } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";

// Matching lines kept per file; rg reads one more to tell an exact-cap file from one with more.
export const MAX_PER_FILE = 50;
// Long lines are shipped as a window around the match so one hit can't eat the whole budget.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;

// UTF-8 byte width of one code point; the arithmetic Buffer.byteLength does, without allocating a Buffer per character.
const utf8Width = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4);

// rg reports byte offsets into the line; this converts to JS string offsets in one forward walk, not a decode per
// offset, since a line can carry thousands of submatches and run to 1 MB.
export const charSpans = (text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchSpan[] => {
    // All-ASCII needs no conversion, but spans are still rebuilt so nothing extra from rg's JSON survives.
    if (Buffer.byteLength(text, "utf8") === text.length) {
        return spans.map((span) => ({ start: span.start, end: span.end }));
    }
    const wanted = [...new Set(spans.flatMap((span) => [span.start, span.end]))].toSorted((a, b) => a - b);
    const chars = new Map<number, number>();
    let byte = 0;
    let index = 0;
    let next = 0;
    while (index < text.length && next < wanted.length) {
        while (next < wanted.length && wanted[next]! <= byte) {
            chars.set(wanted[next]!, index);
            next += 1;
        }
        const code = text.codePointAt(index)!;
        byte += utf8Width(code);
        index += code < 0x1_0000 ? 1 : 2;
    }
    // Anything the walk never reached points past the line, clamped to its end.
    for (; next < wanted.length; next += 1) {
        chars.set(wanted[next]!, text.length);
    }
    return spans.map((span) => ({ start: chars.get(span.start)!, end: chars.get(span.end)! }));
};

// A matching line as shipped: the text kept of it, and the spans that survive the cut.
interface Snippet {
    readonly text: string;
    readonly spans: WorkspaceSearchSpan[];
}

// The slice of a long line worth shipping, anchored on its first match; surviving spans are rebased onto it, and one
// clipped in half is dropped.
export const snippetWindow = (line: string, spans: readonly WorkspaceSearchSpan[]): Snippet => {
    if (line.length <= SNIPPET_MAX) {
        return { text: line, spans: [...spans] };
    }
    const from = Math.max(0, (spans[0]?.start ?? 0) - SNIPPET_LEAD);
    const to = from + SNIPPET_MAX;
    return {
        text: line.slice(from, to),
        spans: spans.filter((span) => span.start >= from && span.end <= to).map((span) => ({ start: span.start - from, end: span.end - from })),
    };
};
