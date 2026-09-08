import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isConversationId, type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract";

// One JSONL file per conversation, appended per settled turn, on the HISTORY volume. Not the live path; a running turn
// is served from its frame log and lands here once it settles.

// Ids are filename-safe by construction; a name that fails validation is never trusted into a path.
// Window size is counted in user turns, not rows, so a page starts on a question rather than mid-answer. `maxRows` caps
// a single turn with many rows from taking over the whole page.
export interface TranscriptWindow {
    // Exclusive: rows before this position, the previous page's `from`. Absent means the end of the record.
    readonly before?: number | undefined;
    readonly turns?: number | undefined;
    readonly maxRows?: number | undefined;
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
// index means.
const rawRows = async (path: string): Promise<string[]> => {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    return raw === undefined ? [] : raw.split("\n").filter((line) => line.length > 0);
};

// Clamps a cursor to a valid end position: past the end clamps to the end, below zero to zero, fractional floors,
// absent means the end.
const pageEnd = (before: number | undefined, length: number): number => Math.min(Math.max(Math.floor(before ?? length), 0), length);

// Walks back from `end` collecting rows until `turns` user messages have opened or `maxRows` is hit; only collected
// rows are parsed.
const scanBack = (at: (index: number) => TranscriptRow[], end: number, turns: number, maxRows: number): TranscriptPage => {
    const rows: TranscriptRow[] = [];
    let from = end;
    let seen = 0;
    for (let index = end - 1; index >= 0; index -= 1) {
        const parsed = at(index);
        if (parsed[0]?.role === "user") {
            seen += 1;
        }
        rows.unshift(...parsed);
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

// Same windowing as `window`, for a caller that already holds the whole record in memory.
export const windowOf = (
    rows: readonly TranscriptRow[],
    { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS }: TranscriptWindow,
): TranscriptPage => scanBack((index) => (rows[index] === undefined ? [] : [rows[index]]), pageEnd(before, rows.length), turns, maxRows);

export const fileTranscriptRecord = (dir: string): TranscriptRecord => ({
    fork: async (conversationId, source, keep) => {
        if (!isConversationId(conversationId) || !isConversationId(source) || keep <= 0) {
            return;
        }
        const path = join(dir, `${conversationId}.jsonl`);
        const opened = await stat(path).then(
            () => true,
            () => false,
        );
        if (opened) {
            return;
        }
        // Raw rows, so this keeps exactly the rows `count` and `truncate` would, torn or unparseable lines included.
        const rows = (await rawRows(join(dir, `${source}.jsonl`))).slice(0, keep);
        if (rows.length === 0) {
            return;
        }
        await mkdir(dir, { recursive: true });
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
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, `${conversationId}.jsonl`), lines(messages));
    },
    read: async (conversationId) => {
        if (!isConversationId(conversationId)) {
            return [];
        }
        return (await rawRows(join(dir, `${conversationId}.jsonl`))).flatMap(row);
    },
    window: async (conversationId, { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS }) => {
        if (!isConversationId(conversationId)) {
            return { rows: [], from: 0, more: false };
        }
        // Raw rows, the same position `count` and `truncate` use, so `from` addresses the same message a rewind would.
        const raw = await rawRows(join(dir, `${conversationId}.jsonl`));
        // Only the returned rows are parsed; splitting the file is cheap, JSON.parse is not.
        return scanBack((index) => row(raw[index] ?? ""), pageEnd(before, raw.length), turns, maxRows);
    },
    count: async (conversationId) => (isConversationId(conversationId) ? (await rawRows(join(dir, `${conversationId}.jsonl`))).length : 0),
    size: async (conversationId) => {
        if (!isConversationId(conversationId)) {
            return undefined;
        }
        return stat(join(dir, `${conversationId}.jsonl`)).then(
            (info) => info.size,
            () => undefined,
        );
    },
    truncate: async (conversationId, keep) => {
        if (!isConversationId(conversationId)) {
            return 0;
        }
        const path = join(dir, `${conversationId}.jsonl`);
        const rows = await rawRows(path);
        if (rows.length <= keep) {
            return 0;
        }
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(
            temp,
            rows
                .slice(0, keep)
                .map((line) => `${line}\n`)
                .join(""),
        );
        await rename(temp, path);
        return rows.length - keep;
    },
});
