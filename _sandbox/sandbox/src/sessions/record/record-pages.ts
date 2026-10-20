import { type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract/events/transcript";
import { positionRowId } from "@intentic/sandbox-contract/ids/row-ids";
import { parseJsonOr } from "@intentic/base/json";
import type { LogIndex } from "./record-log.js";
import { previewOf } from "./record-rows.js";

// HOW A RECORD IS READ A PAGE AT A TIME (transcript-record.ts): back from a position in user turns, or forward from a
// reader's cursor, each bounded in rows and in the bytes the page serves, and every row named, by the id it was recorded
// under or, for a row recorded before rows had ids, by its position. One walk for a record on disk and one in memory
// (the route fakes), so the two cannot answer a page differently.

// Window size is counted in user turns, not rows, so a page starts on a question rather than mid-answer. `maxRows` caps
// a single turn with many rows from taking over the whole page.
export interface TranscriptWindow {
    // Exclusive: rows before this position, the previous page's `from`. Absent means the end of the record.
    readonly before?: number | undefined;
    readonly turns?: number | undefined;
    readonly maxRows?: number | undefined;
    // Ceiling on the page in bytes, whatever the turn and row counts allow: a row carries whole tool outputs, so a
    // handful of turns runs to tens of megabytes.
    readonly maxBytes?: number | undefined;
    // Trims a row to what the reader will actually carry, applied as it is taken. The budget has to measure the served
    // row, not the stored one, or a page that ships 1 MB is cut as though it shipped 60.
    readonly fit?: ((row: TranscriptRow) => TranscriptRow) | undefined;
    // Reading forward from a reader's cursor: the rows from `after` on, when the row just before it is still `afterRow`
    // and they fit one page; otherwise the latest page, said not to be `continuous`. Ignored beside `before`.
    readonly after?: number | undefined;
    readonly afterRow?: string | undefined;
}

export interface TranscriptPage {
    readonly rows: TranscriptRow[];
    // Absolute position of these rows in the whole record, not relative to the page above.
    readonly from: number;
    // Whether earlier rows exist, so a client can offer paging back without a second request.
    readonly more: boolean;
    // The position just past this page: the reader's `after` for its next read.
    readonly through?: number;
    // Answered to a read with `after` only: whether these rows carry on from there, or are the latest page instead.
    readonly continuous?: boolean;
}

// What a forward read takes: the reader's cursor, and the same bounds a page has.
export interface TranscriptForwardWindow {
    readonly after: number;
    readonly afterRow?: string | undefined;
    readonly maxRows?: number | undefined;
    readonly maxBytes?: number | undefined;
    readonly fit?: ((row: TranscriptRow) => TranscriptRow) | undefined;
}

// The rows a record gained past a reader's cursor: positions `from` (its `after`) to `through` (the record's length).
export interface TranscriptForward {
    readonly rows: TranscriptRow[];
    readonly from: number;
    readonly through: number;
}

// Default window: enough that a chat opens on more than a screenful without scaling with conversation length.
const DEFAULT_WINDOW_TURNS = 20;
const MAX_WINDOW_ROWS = 400;
// Byte ceiling on one page. Measured on this workspace's records, the turn and row counts alone leave the median page
// at 275 KB and the worst at 62 MB, because length lives in the rows rather than in how many there are.
export const MAX_WINDOW_BYTES = 2_000_000;

// How a stored line is read back before it is parsed: as a page reads it (previewOf), whole, or with its delegations'
// calls; each the same shape as the first.
export type StoredReader = typeof previewOf;

// Parses one stored line through `read`: whole, as a page reads it, or with its delegations' calls. A row that fails
// the current schema, or a line that is not JSON, is dropped rather than failing the whole read.
export const rowOf = async (line: string, read: StoredReader): Promise<TranscriptRow[]> => {
    const parsed = parseJsonOr(line, undefined);
    if (parsed === undefined) {
        return [];
    }
    const message = TranscriptRowSchema.safeParse(await read(parsed));
    return message.success ? [message.data] : [];
};

// A row as read, named by its position when it was recorded before rows had ids. Positions never move under a row that
// stays (a rewind only drops what comes after), so every read of the record names the row the same way.
export const withRowId = (row: TranscriptRow, position: number): TranscriptRow => (row.rowId === undefined ? { ...row, rowId: positionRowId(position) } : row);

// Every line at its position, each row named.
export const rowsAt = async (lines: readonly string[], read: StoredReader): Promise<TranscriptRow[]> =>
    (await Promise.all(lines.map(async (line, position) => (await rowOf(line, read)).map((row) => withRowId(row, position))))).flat();

// A legacy record as a page reads it, a line that does not parse kept as an empty notice so positions hold.
export const legacyPageRows = async (legacy: readonly string[]): Promise<TranscriptRow[]> =>
    (await Promise.all(legacy.map((line) => rowOf(line, previewOf)))).map((parsed) => parsed[0] ?? { role: "notice" as const, text: "" });

// Clamps a cursor to a valid end position: past the end clamps to the end, below zero to zero, fractional floors,
// absent means the end.
const pageEnd = (before: number | undefined, length: number): number => Math.min(Math.max(Math.floor(before ?? length), 0), length);

// One stored position as the page will carry it: the rows it yields, and what they cost against the byte budget.
type Taken = (index: number) => Promise<{ readonly rows: TranscriptRow[]; readonly bytes: number }>;

interface PageBounds {
    readonly turns: number;
    readonly maxRows: number;
    readonly maxBytes: number;
}

// Walks back from `end` collecting rows until `turns` user messages have opened, or `maxRows`/`maxBytes` is hit; only
// collected rows are parsed.
const scanBack = async (at: Taken, end: number, { turns, maxRows, maxBytes }: PageBounds): Promise<TranscriptPage> => {
    const rows: TranscriptRow[] = [];
    let from = end;
    let seen = 0;
    let bytes = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
        // each row decides whether the page needs the one before it.
        const taken = await at(index);
        const rowsTaken = taken.rows.map((row) => withRowId(row, index));
        // Never checked against an empty page: a single turn larger than the whole budget is still served, since
        // withholding it would leave the chat with nothing to show at all.
        if (rows.length > 0 && bytes + taken.bytes > maxBytes) {
            break;
        }
        if (rowsTaken[0]?.role === "user") {
            seen += 1;
        }
        rows.unshift(...rowsTaken);
        bytes += taken.bytes;
        from = index;
        // Stops on the user row that opens the oldest wanted turn, not the row after it, so its answers keep their
        // question.
        if (seen === turns) {
            break;
        }
        // Row ceiling wins over the turn boundary; `more` carries whatever a fanned-out turn leaves behind.
        if (end - from >= maxRows) {
            break;
        }
    }
    return { rows, from, more: from > 0, through: end };
};

// Walks forward from `after` to `length`, the rows a reader holding everything before `after` lacks; undefined when
// they do not fit `maxRows`/`maxBytes`, counted as `scanBack` counts them, or the row before `after` is no longer the
// one the reader names (a rewind since, which reuses positions).
const scanForward = async (
    at: Taken,
    length: number,
    { after, afterRow, maxRows = MAX_WINDOW_ROWS, maxBytes = MAX_WINDOW_BYTES }: TranscriptForwardWindow,
): Promise<TranscriptForward | undefined> => {
    if (!Number.isInteger(after) || after < 0 || after > length || length - after > maxRows) {
        return undefined;
    }
    if (after > 0) {
        const before = (await at(after - 1)).rows[0];
        if (afterRow === undefined || before === undefined || withRowId(before, after - 1).rowId !== afterRow) {
            return undefined;
        }
    }
    const rows: TranscriptRow[] = [];
    let bytes = 0;
    for (let index = after; index < length; index += 1) {
        // in order, each counted against the budget before the next is read.
        const taken = await at(index);
        // A single row past the budget is served alone, as `scanBack` would; past that the latest page answers.
        if (rows.length > 0 && bytes + taken.bytes > maxBytes) {
            return undefined;
        }
        bytes += taken.bytes;
        rows.push(...taken.rows.map((row) => withRowId(row, index)));
    }
    return { rows, from: after, through: length };
};

// A page asked with `after`: what the record gained past it when that carries on from the reader's cursor, else the
// latest page, said not to be continuous. `before` wins over `after`: a reader paging back is not reading forward.
const pageOf = async (
    window: TranscriptWindow,
    forward: (window: TranscriptForwardWindow) => Promise<TranscriptForward | undefined>,
    back: (window: TranscriptWindow) => Promise<TranscriptPage>,
): Promise<TranscriptPage> => {
    if (window.after === undefined || window.before !== undefined) {
        return back(window);
    }
    const { after, afterRow, maxRows, maxBytes, fit } = window;
    const gained = await forward({ after, afterRow, maxRows, maxBytes, fit });
    if (gained !== undefined) {
        return { ...gained, more: gained.from > 0, continuous: true };
    }
    return { ...(await back({ ...window, after: undefined, afterRow: undefined })), continuous: false };
};

const servedSize = (rows: readonly TranscriptRow[]): number => rows.reduce((total, served) => total + JSON.stringify(served).length, 0);

// A record's positions, however it is held: how many there are, and each as a page carries it.
export interface Positioned {
    readonly length: number;
    readonly taken: (fit: TranscriptWindow["fit"]) => Taken;
}

// An in-memory record's positions, each measured as it is served.
export const memoryPositioned = (rows: readonly TranscriptRow[]): Positioned => ({
    length: rows.length,
    taken: (fit) => async (index) => {
        const found = rows[index];
        const taken = found === undefined ? [] : [fit === undefined ? found : fit(found)];
        return { rows: taken, bytes: servedSize(taken) };
    },
});

// One stored line as a page carries it. Unfitted, the stored line is what goes out, so its own length is the cost and
// nothing is re-measured.
const storedTaken = async (line: string, fit: TranscriptWindow["fit"]): Promise<{ readonly rows: TranscriptRow[]; readonly bytes: number }> => {
    const parsed = await rowOf(line, previewOf);
    if (fit === undefined) {
        return { rows: parsed, bytes: line.length };
    }
    const fitted = parsed.map(fit);
    return { rows: fitted, bytes: servedSize(fitted) };
};

// A record that is not there: every page of it empty.
export const NO_POSITIONS: Positioned = memoryPositioned([]);

// A log's positions, each read through `lineIn` (the record's frame cache); none when there is no log.
export const logPositioned = (index: LogIndex | undefined, lineIn: (index: LogIndex, at: number) => Promise<string>): Positioned =>
    index === undefined ? NO_POSITIONS : { length: index.rows, taken: (fit) => async (at) => storedTaken(await lineIn(index, at), fit) };

export const forwardIn = (at: Positioned, window: TranscriptForwardWindow): Promise<TranscriptForward | undefined> =>
    scanForward(at.taken(window.fit), at.length, window);

export const pageIn = (at: Positioned, window: TranscriptWindow): Promise<TranscriptPage> =>
    pageOf(
        window,
        (forward) => forwardIn(at, forward),
        ({ before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS, maxBytes = MAX_WINDOW_BYTES, fit }) =>
            scanBack(at.taken(fit), pageEnd(before, at.length), { turns, maxRows, maxBytes }),
    );

// Same windowing as `window`, for a caller that already holds the whole record in memory.
export const windowOf = (rows: readonly TranscriptRow[], window: TranscriptWindow): Promise<TranscriptPage> => pageIn(memoryPositioned(rows), window);
