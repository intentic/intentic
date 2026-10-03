import type { ILink, Terminal } from "@xterm/xterm";

// Rejoins plain-text URLs that wrap across terminal rows: xterm's own soft wraps, and the hard newlines a narrower
// panel emits, which xterm's web-links addon misses. A continuation row is a solid run of URL-safe characters, since
// prose always has an interior space. Buffer-agnostic via a `rowAt` accessor, testable without a terminal.

// Looser than xterm's pattern at the tail; trailing punctuation is trimmed once after fragments join.
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi;

// An entire row of URL-safe characters with no interior whitespace; prose always has a space.
const SOLID_RUN = /^[^\s"'<>`]+$/;

// Sentence punctuation the joined run may collect at its tail.
const TRAILING_PUNCTUATION = /[)\]},.;:'"!?]$/;

// Bounds the stitch walk so a long solid-run block cannot turn one hover into an unbounded buffer scan.
const MAX_URL_CHARS = 4096;
const MAX_RUN_ROWS = 64;

// Where one URL sits in the buffer: the rows it spans, and each end row's start/end string index. Indices, not
// columns, since the scan never sees cells.
export interface UrlSpan {
    readonly url: string;
    readonly startRow: number;
    readonly startIndex: number;
    readonly endRow: number;
    readonly endIndex: number;
}

// Reads one buffer row's right-trimmed text, or undefined past the end of the buffer.
export type RowAt = (row: number) => string | undefined;

// Only offers a link that opens exactly as shown; `new URL` can silently repair its input, so the parse must
// round-trip the origin the row displays (userinfo is spelled out since `origin` drops it).
const isOpenable = (url: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    const shown =
        parsed.username === ``
            ? `${parsed.protocol}//${parsed.host}`
            : parsed.password === ``
              ? `${parsed.protocol}//${parsed.username}@${parsed.host}`
              : `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.host}`;
    return url.toLowerCase().startsWith(shown.toLowerCase());
};

// Grows one match downward while the run continues, then trims the sentence punctuation it collected.
const stitch = (rowAt: RowAt, startRow: number, startIndex: number, head: string): UrlSpan | undefined => {
    let url = head;
    let endRow = startRow;
    let endIndex = startIndex + head.length - 1;
    let endText = rowAt(startRow) ?? ``;
    // Continues only if the URL reaches its row's trimmed end, true for both a soft and a hard wrap.
    while (endIndex === endText.length - 1 && url.length < MAX_URL_CHARS && endRow - startRow < MAX_RUN_ROWS) {
        const next = rowAt(endRow + 1);
        if (next === undefined) {
            break;
        }
        // Panels may indent every wrapped line; after the indent a real fragment is still a solid run, unlike prose.
        const fragment = next.trimStart();
        if (fragment === `` || !SOLID_RUN.test(fragment)) {
            break;
        }
        url += fragment;
        endRow += 1;
        endIndex = next.length - 1;
        endText = next;
    }
    // Never trims below one character on the row the span ends on.
    const floor = endRow === startRow ? startIndex : endText.length - endText.trimStart().length;
    while (endIndex > floor && TRAILING_PUNCTUATION.test(url)) {
        url = url.slice(0, -1);
        endIndex -= 1;
    }
    return isOpenable(url) ? { url, startRow, startIndex, endRow, endIndex } : undefined;
};

// Every URL beginning in [firstRow, lastRow], stitched through however many rows it wraps onto; a span may end
// past lastRow. Pair with runStart to also catch spans reaching into firstRow from above.
export const findUrls = (rowAt: RowAt, firstRow: number, lastRow: number): UrlSpan[] => {
    const spans: UrlSpan[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
        const text = rowAt(row);
        if (text === undefined) {
            break;
        }
        for (const match of text.matchAll(URL_PATTERN)) {
            const span = stitch(rowAt, row, match.index, match[0]);
            if (span === undefined) {
                continue;
            }
            spans.push(span);
            // Skips rows this URL consumed; only a row's last match can stitch.
            row = span.endRow;
        }
    }
    return spans;
};

// First row of the wrapped run `row` belongs to, walking up while the row above is a bare continuation fragment.
// Stops at prose, the buffer top, a blank line, or a row a URL could start on.
export const runStart = (rowAt: RowAt, row: number): number => {
    let first = row;
    while (first > 0 && row - first < MAX_RUN_ROWS) {
        const fragment = rowAt(first)?.trimStart();
        if (fragment === undefined || fragment === `` || !SOLID_RUN.test(fragment)) {
            return first;
        }
        const above = rowAt(first - 1);
        if (above === undefined || above === ``) {
            return first;
        }
        first -= 1;
    }
    return first;
};

// Right-trimmed text plus the buffer column each character starts and ends on. xterm collapses a wide glyph and
// combining marks into one cell, so a string index isn't a column.
interface RowCells {
    readonly text: string;
    readonly firstColumns: readonly number[];
    readonly lastColumns: readonly number[];
}

const readRow = (term: Terminal, row: number): RowCells | undefined => {
    const line = term.buffer.active.getLine(row);
    if (line === undefined) {
        return undefined;
    }
    const cell = term.buffer.active.getNullCell();
    let text = ``;
    const firstColumns: number[] = [];
    const lastColumns: number[] = [];
    for (let column = 0; column < line.length; column++) {
        line.getCell(column, cell);
        const width = cell.getWidth();
        if (width === 0) {
            // Trailing half of a wide glyph; holds no characters of its own.
            continue;
        }
        // An empty cell reads as a space, matching translateToString.
        const chars = cell.getChars() === `` ? ` ` : cell.getChars();
        for (let index = 0; index < chars.length; index++) {
            firstColumns.push(column);
            lastColumns.push(column + width - 1);
        }
        text += chars;
    }
    // Right-trim only: a panel's leading indent is real content for the column mapping.
    return { text: text.replace(/\s+$/, ``), firstColumns, lastColumns };
};

// Every URL link covering one buffer row (1-based, as xterm addresses rows), with its range in buffer cells. Reads
// rows, stitches, and maps back onto cells, so it is exercisable against a real buffer without a DOM.
export const urlLinksAt = (term: Terminal, bufferLineNumber: number, activate: (event: MouseEvent, uri: string) => void): ILink[] => {
    // Reads each row at most once per call; runStart, findUrls, and the column mapping share rows.
    const reads = new Map<number, RowCells | undefined>();
    const cells = (row: number): RowCells | undefined => {
        if (!reads.has(row)) {
            reads.set(row, readRow(term, row));
        }
        return reads.get(row);
    };
    const rowAt: RowAt = (row) => cells(row)?.text;
    const hovered = bufferLineNumber - 1;
    return findUrls(rowAt, runStart(rowAt, hovered), hovered).flatMap((span) => {
        // A span found above the hovered row may also end above it; only spans reaching this row belong to it.
        if (span.endRow < hovered) {
            return [];
        }
        const start = cells(span.startRow);
        const end = cells(span.endRow);
        if (start === undefined || end === undefined) {
            return [];
        }
        // xterm's range is 1-based and inclusive at both ends; both lookups are always in range.
        return [
            {
                text: span.url,
                range: {
                    start: { x: (start.firstColumns[span.startIndex] ?? 0) + 1, y: span.startRow + 1 },
                    end: { x: (end.lastColumns[span.endIndex] ?? 0) + 1, y: span.endRow + 1 },
                },
                activate,
            },
        ];
    });
};

// Registers the URL linkifier on one terminal, replacing @xterm/addon-web-links, whose provider would shadow this
// one on a wrapped link's first fragment.
export const registerUrlLinks = (term: Terminal, activate: (event: MouseEvent, uri: string) => void): void => {
    term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            const links = urlLinksAt(term, bufferLineNumber, activate);
            callback(links.length === 0 ? undefined : links);
        },
    });
};
