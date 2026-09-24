import { appendFile, type FileHandle, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { isConversationId, type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract";
import { conversationUnit } from "../store/conversation-units.js";
import { writeTextFile } from "../store/text-file.js";

// One JSONL file per conversation, in its unit on the HISTORY volume, appended per settled turn. Not the live path; a
// running turn is served from its frame log and lands here once it settles.

// Where one conversation's record lives; also what `agents show` names as the record's path.
export const transcriptFile = (historyRoot: string, conversationId: string): string => join(conversationUnit(historyRoot, conversationId), "transcript.jsonl");

// Ids are filename-safe by construction; a name that fails validation is never trusted into a path.
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
}

export interface TranscriptPage {
    readonly rows: TranscriptRow[];
    // Absolute position of these rows in the whole record, not relative to the page above.
    readonly from: number;
    // Whether earlier rows exist, so a client can offer paging back without a second request.
    readonly more: boolean;
}

// Default window: enough that a chat opens on more than a screenful without scaling with conversation length.
export const DEFAULT_WINDOW_TURNS = 20;
export const MAX_WINDOW_ROWS = 400;
// Byte ceiling on one page. Measured on this workspace's records, the turn and row counts alone leave the median page
// at 275 KB and the worst at 62 MB, because length lives in the rows rather than in how many there are.
export const MAX_WINDOW_BYTES = 2_000_000;

export interface TranscriptRecord {
    // Copies another record's first `keep` rows to start a branch; a `wx` write, a no-op if the file already exists.
    readonly fork: (conversationId: string, source: string, keep: number) => Promise<void>;
    // Appends one settled turn, creating the record on the first call.
    readonly append: (conversationId: string, messages: readonly TranscriptRow[]) => Promise<void>;
    // Returns the whole conversation, oldest first; empty means no record exists. Costs the whole conversation's
    // length; prefer `window` for a reader that only needs the tail.
    readonly read: (conversationId: string) => Promise<TranscriptRow[]>;
    // Returns the tail of a conversation and where it sits; only the returned rows are parsed, so cost scales with the
    // window, not the conversation. A cursor is never an error: out-of-range values clamp instead of failing.
    readonly window: (conversationId: string, window: TranscriptWindow) => Promise<TranscriptPage>;
    // Newest row back, for a reader looking for one thing rather than a span; rows are parsed one at a time, so a hit
    // near the tail costs the tail rather than the record.
    readonly findBack: (conversationId: string, match: (row: TranscriptRow) => boolean) => Promise<TranscriptRow | undefined>;
    // Record's byte size, undefined when no record exists; changes on every append or truncate, usable as a version
    // key.
    readonly size: (conversationId: string) => Promise<number | undefined>;
    // Number of stored rows, the index the next append and its checkpoint start at. Counts raw rows, not parsed
    // messages, so a dropped bad row cannot offset the count.
    readonly count: (conversationId: string) => Promise<number>;
    // Drops every message after `keep`, the only operation that shortens a record. Written via a temp file and rename
    // so a concurrent reader never sees a partial file; returns 0 if already short enough.
    readonly truncate: (conversationId: string, keep: number) => Promise<number>;
}

const lines = (messages: readonly TranscriptRow[]): string => messages.map((message) => `${JSON.stringify(message)}\n`).join("");

// Parses one stored line; a torn write or a row that fails the current schema is dropped rather than failing the whole
// read.
const row = (line: string): TranscriptRow[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return [];
    }
    const message = TranscriptRowSchema.safeParse(parsed);
    return message.success ? [message.data] : [];
};

// Unparsed stored lines, the shared notion of position for read, count and truncate; they must agree on what a given
// index means. Only an absent record is empty: one that cannot be read is not a conversation with no history.
const rawRows = async (path: string): Promise<string[]> => {
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    return raw === undefined ? [] : raw.split("\n").filter((line) => line.length > 0);
};

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
        // oxlint-disable-next-line eslint/no-await-in-loop -- each row decides whether the page needs the one before it.
        const taken = await at(index);
        // Never checked against an empty page: a single turn larger than the whole budget is still served, since
        // withholding it would leave the chat with nothing to show at all.
        if (rows.length > 0 && bytes + taken.bytes > maxBytes) {
            break;
        }
        if (taken.rows[0]?.role === "user") {
            seen += 1;
        }
        rows.unshift(...taken.rows);
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
    return { rows, from, more: from > 0 };
};

const servedSize = (rows: readonly TranscriptRow[]): number => rows.reduce((total, served) => total + JSON.stringify(served).length, 0);

// Same windowing as `window`, for a caller that already holds the whole record in memory.
export const windowOf = (
    rows: readonly TranscriptRow[],
    { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS, maxBytes = MAX_WINDOW_BYTES, fit }: TranscriptWindow,
): Promise<TranscriptPage> =>
    scanBack(
        async (index) => {
            const found = rows[index];
            const taken = found === undefined ? [] : [fit === undefined ? found : fit(found)];
            return { rows: taken, bytes: servedSize(taken) };
        },
        pageEnd(before, rows.length),
        { turns, maxRows, maxBytes },
    );

// Where each stored row sits in its file, so a count is a stat and a page reads only its own rows: the largest record
// here was 60 MB over 149 rows, and decoding it whole blocked the daemon's loop for a quarter second on every turn.
interface RowIndex {
    readonly size: number;
    readonly mtimeMs: number;
    // Byte span of each non-empty line, newline excluded: exactly the rows `rawRows` splits out, in file order.
    readonly starts: readonly number[];
    readonly ends: readonly number[];
    // Past the last newline: rows before it are final, and a torn last line is rescanned with whatever follows it.
    readonly settled: number;
}

// One read of the scan: a record is a few dozen of them, and the buffer is one passing allocation.
const SCAN_CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

// Records whose index is kept, least recently read dropped first; one dropped costs a byte scan to reopen.
const INDEXES_KEPT = 256;

// Appends the rows of [from, size) to `starts` and `ends`, scanning bytes for newlines and never decoding them, which is
// safe because no byte of a multi-byte UTF-8 sequence is a newline. Returns where the last complete line ended.
const scanRows = async (handle: FileHandle, from: number, size: number, starts: number[], ends: number[]): Promise<number> => {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let lineStart = from;
    let position = from;
    while (position < size) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one buffer, read in file order.
        const { bytesRead } = await handle.read(buffer, 0, Math.min(SCAN_CHUNK, size - position), position);
        if (bytesRead === 0) {
            break;
        }
        const read = buffer.subarray(0, bytesRead);
        for (let at = read.indexOf(NEWLINE); at !== -1; at = read.indexOf(NEWLINE, at + 1)) {
            const end = position + at;
            if (end > lineStart) {
                starts.push(lineStart);
                ends.push(end);
            }
            lineStart = end + 1;
        }
        position += bytesRead;
    }
    // A final line with no newline is a torn write, still a row, as the raw split counts it.
    if (position > lineStart) {
        starts.push(lineStart);
        ends.push(position);
    }
    return lineStart;
};

const readRow = async (handle: FileHandle, index: RowIndex, at: number): Promise<string> => {
    const start = index.starts[at] ?? 0;
    const length = (index.ends[at] ?? start) - start;
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(bytes, 0, length, start);
    return bytes.toString("utf8", 0, bytesRead);
};

const emptyPage = (): TranscriptPage => ({ rows: [], from: 0, more: false });

// What an index keeps when its record has grown, which only an append does: every row before the last newline, with a
// torn last line dropped to be rescanned along with whatever now follows it. Any other change starts from nothing.
const carried = (known: RowIndex | undefined, size: number): { readonly starts: number[]; readonly ends: number[]; readonly from: number } => {
    if (known === undefined || size <= known.size) {
        return { starts: [], ends: [], from: 0 };
    }
    const complete = (known.starts.at(-1) ?? -1) >= known.settled ? known.starts.length - 1 : known.starts.length;
    return { starts: known.starts.slice(0, complete), ends: known.ends.slice(0, complete), from: known.settled };
};

export const fileTranscriptRecord = (historyRoot: string): TranscriptRecord => {
    const indexes = new Map<string, RowIndex>();

    const remember = (path: string, index: RowIndex): RowIndex => {
        indexes.delete(path);
        indexes.set(path, index);
        const oldest = indexes.keys().next();
        if (indexes.size > INDEXES_KEPT && oldest.done !== true) {
            indexes.delete(oldest.value);
        }
        return index;
    };

    // Validated against the open handle's own stat, so the offsets always describe the file being read, even when a
    // truncate replaces it.
    const indexed = async (path: string, handle: FileHandle): Promise<RowIndex> => {
        const info = await handle.stat();
        const known = indexes.get(path);
        if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) {
            return remember(path, known);
        }
        const kept = carried(known, info.size);
        const settled = await scanRows(handle, kept.from, info.size, kept.starts, kept.ends);
        return remember(path, { size: info.size, mtimeMs: info.mtimeMs, starts: kept.starts, ends: kept.ends, settled });
    };

    // Runs `use` over one open, indexed record; a record that doesn't exist answers `absent`, one that won't open throws.
    const opened = async <T>(conversationId: string, absent: T, use: (handle: FileHandle, index: RowIndex) => Promise<T>): Promise<T> => {
        const path = transcriptFile(historyRoot, conversationId);
        const handle = await open(path, "r").catch(undefinedIfMissing);
        if (handle === undefined) {
            indexes.delete(path);
            return absent;
        }
        try {
            return await use(handle, await indexed(path, handle));
        } finally {
            await handle.close();
        }
    };

    return {
        fork: async (conversationId, source, keep) => {
            if (!isConversationId(conversationId) || !isConversationId(source) || keep <= 0) {
                return;
            }
            const path = transcriptFile(historyRoot, conversationId);
            const exists = await stat(path).then(
                () => true,
                () => false,
            );
            if (exists) {
                return;
            }
            // Raw rows, so this keeps exactly the rows `count` and `truncate` would, torn or unparseable lines included.
            const rows = (await rawRows(transcriptFile(historyRoot, source))).slice(0, keep);
            if (rows.length === 0) {
                return;
            }
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, rows.map((line) => `${line}\n`).join(""), { flag: "wx" }).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
            });
        },
        append: async (conversationId, messages) => {
            if (!isConversationId(conversationId) || messages.length === 0) {
                return;
            }
            const path = transcriptFile(historyRoot, conversationId);
            await mkdir(dirname(path), { recursive: true });
            await appendFile(path, lines(messages));
        },
        read: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return [];
            }
            return (await rawRows(transcriptFile(historyRoot, conversationId))).flatMap(row);
        },
        window: async (conversationId, { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS, maxBytes = MAX_WINDOW_BYTES, fit }) => {
            if (!isConversationId(conversationId)) {
                return emptyPage();
            }
            // Row positions, the same ones `count` and `truncate` use, so `from` addresses the message a rewind would.
            return opened(conversationId, emptyPage(), (handle, index) =>
                scanBack(
                    async (at) => {
                        const line = await readRow(handle, index, at);
                        const parsed = row(line);
                        // Unfitted, the stored line is what goes out, so its own length is the cost and nothing is re-measured.
                        if (fit === undefined) {
                            return { rows: parsed, bytes: line.length };
                        }
                        const fitted = parsed.map(fit);
                        return { rows: fitted, bytes: servedSize(fitted) };
                    },
                    pageEnd(before, index.starts.length),
                    { turns, maxRows, maxBytes },
                ),
            );
        },
        findBack: async (conversationId, match) => {
            if (!isConversationId(conversationId)) {
                return undefined;
            }
            return opened(conversationId, undefined, async (handle, index) => {
                for (let at = index.starts.length - 1; at >= 0; at -= 1) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- newest first, and the first hit ends the search.
                    const found = row(await readRow(handle, index, at)).find(match);
                    if (found !== undefined) {
                        return found;
                    }
                }
                return undefined;
            });
        },
        count: async (conversationId) => (isConversationId(conversationId) ? opened(conversationId, 0, async (_handle, index) => index.starts.length) : 0),
        size: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return undefined;
            }
            return stat(transcriptFile(historyRoot, conversationId)).then(
                (info) => info.size,
                () => undefined,
            );
        },
        truncate: async (conversationId, keep) => {
            if (!isConversationId(conversationId)) {
                return 0;
            }
            const path = transcriptFile(historyRoot, conversationId);
            const rows = await rawRows(path);
            if (rows.length <= keep) {
                return 0;
            }
            await writeTextFile(
                path,
                rows
                    .slice(0, keep)
                    .map((line) => `${line}\n`)
                    .join(""),
            );
            indexes.delete(path);
            return rows.length - keep;
        },
    };
};
