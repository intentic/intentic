import type { ILink, Terminal } from "@xterm/xterm";

/* Plain-text URLs in terminal output, rejoined when they wrap across rows.
 *
 * xterm's own web-links addon only rejoins SOFT wraps, the ones the terminal itself made at its width, which
 * mark the continuation row `isWrapped`. A program that wraps text to its OWN narrower panel emits real
 * newlines instead, and every fragment after the first is then invisible to that addon: `claude`'s login panel
 * does exactly this, so Ctrl+clicking its OAuth URL opened a truncated, dead link, the one link in the whole
 * app a user cannot work around, because it is what they need to sign the agent in.
 *
 * Both kinds of wrap share one shape: the URL runs to the end of its row, and the next row is a single solid
 * run of URL-safe characters. Stitching on THAT makes `isWrapped` and the terminal's width irrelevant, and
 * prose is never swallowed, a line of prose always has an interior space, so it ends the run.
 *
 * The scan is pure and buffer-agnostic (it reads rows through a `rowAt` accessor) so the stitching rules can be
 * pinned by tests without a terminal; registerUrlLinks is the only part that touches xterm. */

// A URL from its scheme to the end of the run of URL-safe characters. Deliberately looser at the tail than
// xterm's pattern (which forbids sentence punctuation as the LAST character): a fragment that breaks mid-URL at
// a row edge can end in any of those, so trailing punctuation is trimmed once, after the fragments are joined.
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi;

// A continuation fragment is an ENTIRE row of URL-safe characters, no interior whitespace anywhere. The prose
// that follows a URL ("Paste code here >", "Waiting for authentication…") always has a space, so it can never
// be mistaken for the URL's tail, and a blank row ends the run.
const SOLID_RUN = /^[^\s"'<>`]+$/;

// Sentence punctuation the joined run may have collected ("see https://example.com/x.").
const TRAILING_PUNCTUATION = /[)\]},.;:'"!?]$/;

// Stitch ceilings. A wrapped OAuth URL runs a few hundred characters over a dozen-odd rows; these bound the
// walk so a screenful of solid-run output (a base64 blob, a column of lockfile hashes) can't turn one hover
// into an unbounded buffer scan.
const MAX_URL_CHARS = 4096;
const MAX_RUN_ROWS = 64;

// Where one URL sits in the buffer: the rows it spans and, within each end row's text, the string index of its
// first and last character. Indices, not columns, because the scan never sees cells.
export interface UrlSpan {
    readonly url: string;
    readonly startRow: number;
    readonly startIndex: number;
    readonly endRow: number;
    readonly endIndex: number;
}

// Reads one buffer row's right-trimmed text, or undefined past the end of the buffer.
export type RowAt = (row: number) => string | undefined;

// Only offer a link the browser will open as typed. `new URL` silently repairs some inputs, so the parse has to
// round-trip the origin the row actually shows, a link that opens somewhere other than what the user read is
// precisely the confusion a linkifier over arbitrary program output must not create. (The userinfo forms are
// spelled out because `origin` drops them.)
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

// Grow one match downward for as long as the run continues, then drop the sentence punctuation it collected.
const stitch = (rowAt: RowAt, startRow: number, startIndex: number, head: string): UrlSpan | undefined => {
    let url = head;
    let endRow = startRow;
    let endIndex = startIndex + head.length - 1;
    let endText = rowAt(startRow) ?? ``;
    // The URL reaching the end of its (right-trimmed) row is what says it may continue, which is true of a soft
    // wrap and of a panel's hard wrap alike, and false for a URL with anything after it on the row.
    while (endIndex === endText.length - 1 && url.length < MAX_URL_CHARS && endRow - startRow < MAX_RUN_ROWS) {
        const next = rowAt(endRow + 1);
        if (next === undefined) {
            break;
        }
        // Some panels indent every wrapped line (claude's /mcp OAuth prompt), so the fragment isn't flush left.
        // After the indent a real fragment is still one solid run; prose still has its interior spaces.
        const fragment = next.trimStart();
        if (fragment === `` || !SOLID_RUN.test(fragment)) {
            break;
        }
        url += fragment;
        endRow += 1;
        endIndex = next.length - 1;
        endText = next;
    }
    // Never trim into nothing: the span has to keep at least one character on the row it ends on.
    const floor = endRow === startRow ? startIndex : endText.length - endText.trimStart().length;
    while (endIndex > floor && TRAILING_PUNCTUATION.test(url)) {
        url = url.slice(0, -1);
        endIndex -= 1;
    }
    return isOpenable(url) ? { url, startRow, startIndex, endRow, endIndex } : undefined;
};

// Every URL that BEGINS on a row in [firstRow, lastRow], stitched through however many rows it wraps onto, so a
// span can end well below lastRow. Callers pair this with runStart to cover the URLs that reach a given row from
// above.
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
            // Skip the fragments this URL consumed, they are its tail, not rows another URL can start on. Only
            // a row's LAST match can stitch (an earlier one doesn't reach the row's end), so this always lands
            // on the final pass of the inner loop.
            row = span.endRow;
        }
    }
    return spans;
};

// The first row of the wrapped run `row` belongs to: walk up while each row is a bare continuation fragment
// sitting under a row with content to continue from. It stops on the row a URL could START on, prose, the top
// of the buffer, or a blank line, which is where findUrls then begins scanning.
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

// One buffer row read cell by cell: the right-trimmed text plus the 0-based buffer column each of its characters
// starts at and ends on. Both are needed because xterm collapses a wide (2-cell) glyph, and any combining marks
// riding on a base character, into a single cell, so a string index is not a column.
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
            // The trailing half of a wide glyph, it holds no characters of its own.
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
    // Right-trim only: a panel's leading indent is real content for the column mapping (and trimStart is what
    // the stitching rules apply where an indent matters).
    return { text: text.replace(/\s+$/, ``), firstColumns, lastColumns };
};

/* Every URL link covering one buffer row (1-based, as xterm addresses rows), with its range in buffer cells.
 * This is the whole buffer-side step, reading rows, stitching, and mapping back onto cells, so it can be
 * exercised against a real terminal buffer without a DOM. */
export const urlLinksAt = (term: Terminal, bufferLineNumber: number, activate: (event: MouseEvent, uri: string) => void): ILink[] => {
    // Read each row at most once per call: runStart, findUrls, and the column mapping all walk the same handful
    // of rows.
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
        // A span found above the hovered row may also END above it (a URL that stopped on an earlier row); only
        // the ones that actually reach this row belong to it.
        if (span.endRow < hovered) {
            return [];
        }
        const start = cells(span.startRow);
        const end = cells(span.endRow);
        if (start === undefined || end === undefined) {
            return [];
        }
        // xterm's range is 1-based and inclusive at both ends. The spans came from the very text these reads
        // produced, so both lookups are in range.
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

/* Register the URL linkifier on one terminal. Replaces @xterm/addon-web-links for URLs, its provider would
 * shadow this one for the first fragment of every wrapped link, and its stitching is the thing being fixed. */
export const registerUrlLinks = (term: Terminal, activate: (event: MouseEvent, uri: string) => void): void => {
    term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
            const links = urlLinksAt(term, bufferLineNumber, activate);
            callback(links.length === 0 ? undefined : links);
        },
    });
};
