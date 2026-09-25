import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { undefinedIfMissing } from "@intentic/base/errors";
import { isConversationId, type TranscriptRow, TranscriptRowSchema } from "@intentic/sandbox-contract";
import { conversationsRoot, conversationUnit } from "../store/conversation-units.js";
import { syncParents } from "./record/record-io.js";
import { getBlob, hashOf, putBlob, sweepBlobs } from "./record/record-blobs.js";
import { type Converted, convertLegacy, framesByTurn, keptLines, type PutBlob } from "./record/record-convert.js";
import { appendLog, current, frameOfRow, type LogIndex, openLog, readFrame, repairLog, writeLog } from "./record/record-log.js";
import { blobNamesIn, callsOf, keptLine, previewOf, wholeOf } from "./record/record-rows.js";

// One zstd log per conversation (sessions/record/record-log.ts), in its unit on the HISTORY volume, a frame appended per
// settled turn and made durable before the append resolves. Not the live path; a running turn is served from its frame
// log and lands here once it settles. `zstdcat` reads a record as the JSONL it holds.

// Where one conversation's record lives; also what `agents show` names as the record's path.
export const transcriptFile = (historyRoot: string, conversationId: string): string =>
    join(conversationUnit(historyRoot, conversationId), "transcript.jsonl.zst");

// The plain JSONL record this build converts from (record/record-migration.ts), read and converted until it is gone.
export const legacyTranscriptFile = (historyRoot: string, conversationId: string): string =>
    join(conversationUnit(historyRoot, conversationId), "transcript.jsonl");

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
    // length, every out-of-line output read back; prefer `window` for a reader that only needs the tail.
    readonly read: (conversationId: string) => Promise<TranscriptRow[]>;
    // Every row as a page reads it (each output its start, each delegation its count), oldest first: for a reader of
    // what was said, which needs none of the out-of-line bytes.
    readonly rows: (conversationId: string) => Promise<TranscriptRow[]>;
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

// Parses one stored line through `read`: whole, as a page reads it, or with its delegations' calls. A row that fails
// the current schema, or a line that is not JSON, is dropped rather than failing the whole read.
const rowOf = async (line: string, read: (stored: unknown) => unknown): Promise<TranscriptRow[]> => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return [];
    }
    const message = TranscriptRowSchema.safeParse(await read(parsed));
    return message.success ? [message.data] : [];
};

// A legacy record's lines, every non-empty one a row position, torn or not.
const legacyLines = async (path: string): Promise<string[] | undefined> => {
    const raw = await readFile(path, "utf8").catch(undefinedIfMissing);
    return raw === undefined ? undefined : raw.split("\n").filter((line) => line.length > 0);
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

// Decoded frames kept across reads, least recently used dropped first past this many characters of JSONL.
const FRAMES_KEPT_CHARS = 32_000_000;
// Records whose index is kept, least recently read dropped first; one dropped costs a walk of its frame prefixes.
const INDEXES_KEPT = 256;
// How long a blob nothing names outlives its last naming: far above the time another process's append takes to land,
// the only write this record's own pins cannot see.
export const BLOB_GRACE_MS = 10 * 60_000;

const emptyPage = (): TranscriptPage => ({ rows: [], from: 0, more: false });

export interface FileTranscriptRecord extends TranscriptRecord {
    // Puts a log the migration wrote at `prepared` in place of the conversation's legacy record, if that record is
    // still the one it was converted from; answers the adopted log's size, undefined when it did not (record-migration.ts).
    readonly adopt: (conversationId: string, prepared: string, converted: Converted) => Promise<number | undefined>;
    // Every line as stored, oldest first: each out-of-line output as the start it kept, each delegation as its blob's
    // name. What a scan for what a record mentions reads, never needing the outputs themselves.
    readonly stored: (conversationId: string) => Promise<string[]>;
    // Removes the blobs no record but those of `gone` names; answers how many went. Must not overlap the migration,
    // whose threads write blobs this record cannot see.
    readonly sweep: (gone: ReadonlySet<string>) => Promise<number>;
}

export const fileTranscriptRecord = (historyRoot: string): FileTranscriptRecord => {
    // One change at a time per conversation: an append, a truncate, a conversion, and the repair of a torn tail.
    const exclusive = keyedLock<string>();
    // Blobs a write is about to name, counted per write, and those a write named since the running sweep read the logs.
    const pinned = new Map<string, number>();
    const named = new Set<string>();
    // One sweep at a time: each starts by forgetting what was named before it read the logs.
    let sweeps: Promise<unknown> = Promise.resolve();
    const indexes = new Map<string, LogIndex>();
    const frames = new Map<string, readonly string[]>();
    let framesChars = 0;

    const forget = (path: string): void => {
        indexes.delete(path);
        for (const held of [...frames.keys()].filter((key) => key.startsWith(`${path}\u0000`))) {
            framesChars -= (frames.get(held) ?? []).reduce((total, line) => total + line.length, 0);
            frames.delete(held);
        }
    };

    const remember = (path: string, index: LogIndex): LogIndex => {
        indexes.delete(path);
        indexes.set(path, index);
        const oldest = indexes.keys().next();
        if (indexes.size > INDEXES_KEPT && oldest.done !== true) {
            forget(oldest.value);
        }
        return index;
    };

    // The log's index, opened when nothing current is held; undefined when there is no log.
    const indexed = async (path: string): Promise<LogIndex | undefined> => {
        const known = indexes.get(path);
        if (known !== undefined && (await current(path, known))) {
            return remember(path, known);
        }
        forget(path);
        const opened = await openLog(path);
        return opened === undefined ? undefined : remember(path, opened);
    };

    const linesOf = async (path: string, index: LogIndex, frame: number): Promise<readonly string[]> => {
        const at = index.frames[frame];
        if (at === undefined) {
            return [];
        }
        const key = `${path}\u0000${String(at.offset)}`;
        const held = frames.get(key);
        if (held !== undefined) {
            frames.delete(key);
            frames.set(key, held);
            return held;
        }
        const read = await readFrame(path, at);
        frames.set(key, read);
        framesChars += read.reduce((total, line) => total + line.length, 0);
        for (const [oldest, lines] of frames) {
            if (framesChars <= FRAMES_KEPT_CHARS || oldest === key) {
                break;
            }
            framesChars -= lines.reduce((total, line) => total + line.length, 0);
            frames.delete(oldest);
        }
        return read;
    };

    const lineAt = async (path: string, index: LogIndex, row: number): Promise<string> => {
        const { frame, line } = frameOfRow(index, row);
        return (await linesOf(path, index, frame))[line] ?? "";
    };

    const allLines = async (path: string, index: LogIndex): Promise<string[]> => {
        const all: string[] = [];
        for (let frame = 0; frame < index.frames.length; frame += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- frames in order, each cached for the next read.
            all.push(...(await linesOf(path, index, frame)));
        }
        return all;
    };

    const get = (hash: string): Promise<string | undefined> => getBlob(historyRoot, hash);
    const whole = (stored: unknown): Promise<unknown> => wholeOf(stored, get);
    const calls = (stored: unknown): Promise<unknown> => callsOf(stored, get);

    // Runs a write that names blobs, each pinned from before it is looked for until the write has landed, then named
    // (see `sweep`); `put` stores one, `hold` pins one already stored.
    const naming = async <T>(write: (put: PutBlob, hold: (hashes: readonly string[]) => void) => Promise<T>): Promise<T> => {
        const held: string[] = [];
        const hold = (hashes: readonly string[]): void => {
            for (const hash of hashes) {
                held.push(hash);
                pinned.set(hash, (pinned.get(hash) ?? 0) + 1);
            }
        };
        try {
            return await write((text) => {
                hold([hashOf(text)]);
                return putBlob(historyRoot, text);
            }, hold);
        } finally {
            for (const hash of held) {
                const left = (pinned.get(hash) ?? 1) - 1;
                if (left === 0) {
                    pinned.delete(hash);
                } else {
                    pinned.set(hash, left);
                }
                named.add(hash);
            }
        }
    };

    // Must hold `exclusive` for the conversation. Converts a legacy record still there before anything changes it: the
    // migration's own step, taken here only for a record it has not reached yet.
    const convertHeld = async (conversationId: string, put: PutBlob): Promise<void> => {
        const legacy = legacyTranscriptFile(historyRoot, conversationId);
        const path = transcriptFile(historyRoot, conversationId);
        if ((await convertLegacy({ historyRoot, conversationId, legacy, target: path, put })) === undefined) {
            return;
        }
        await rm(legacy, { force: true });
        await syncParents(legacy);
        forget(path);
    };

    // What every change runs under: the conversation's lock, its legacy record converted and a torn tail cut first.
    const changing = <T>(conversationId: string, change: (path: string, index: LogIndex | undefined, put: PutBlob) => Promise<T>): Promise<T> =>
        naming((put) =>
            exclusive(conversationId, async () => {
                await convertHeld(conversationId, put);
                const path = transcriptFile(historyRoot, conversationId);
                const index = await indexed(path);
                return change(path, index === undefined ? undefined : remember(path, await repairLog(path, index)), put);
            }),
        );

    // Every line of the log at `path`, read past the frame cache, which a scan of every record would only empty.
    const scanned = async (path: string): Promise<string[]> => {
        const index = await openLog(path);
        const lines: string[] = [];
        for (const frame of index?.frames ?? []) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- frames in order.
            lines.push(...(await readFrame(path, frame)));
        }
        return lines;
    };

    // A record not yet converted reads as its legacy lines, whole; every read converts nothing.
    const legacyRead = async (conversationId: string): Promise<string[] | undefined> =>
        (await stat(transcriptFile(historyRoot, conversationId)).catch(undefinedIfMissing)) === undefined
            ? legacyLines(legacyTranscriptFile(historyRoot, conversationId))
            : undefined;

    // Every write since the logs were read is named, and every write in flight pinned, so what the scan missed is
    // exactly what nothing will name; a plain record names no blob.
    const sweepOnce = async (gone: ReadonlySet<string>): Promise<number> => {
        named.clear();
        const referenced = new Set<string>();
        for (const entry of (await readdir(conversationsRoot(historyRoot), { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) {
            if (entry.isDirectory() && isConversationId(entry.name) && !gone.has(entry.name)) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one record at a time; the sweep is never waited on.
                for (const line of await scanned(transcriptFile(historyRoot, entry.name))) {
                    for (const hash of blobNamesIn(line)) {
                        referenced.add(hash);
                    }
                }
            }
        }
        return sweepBlobs(historyRoot, referenced, (hash) => pinned.has(hash) || named.has(hash), Date.now(), BLOB_GRACE_MS);
    };

    return {
        adopt: (conversationId, prepared, converted) =>
            exclusive(conversationId, async () => {
                const legacy = legacyTranscriptFile(historyRoot, conversationId);
                const now = await stat(legacy).catch(undefinedIfMissing);
                if (now === undefined || now.size !== converted.size || now.mtimeMs !== converted.mtimeMs) {
                    await rm(prepared, { force: true });
                    return undefined;
                }
                const path = transcriptFile(historyRoot, conversationId);
                await rename(prepared, path);
                await syncParents(path);
                await rm(legacy, { force: true });
                await syncParents(legacy);
                forget(path);
                return (await stat(path)).size;
            }),
        fork: async (conversationId, source, keepRows) => {
            if (!isConversationId(conversationId) || !isConversationId(source) || keepRows <= 0) {
                return;
            }
            await naming((put, hold) =>
                exclusive(conversationId, async () => {
                    const path = transcriptFile(historyRoot, conversationId);
                    if ((await stat(path).catch(undefinedIfMissing)) !== undefined) {
                        return;
                    }
                    // Stored lines, so this keeps exactly the rows `count` and `truncate` would, and shares the source's blobs.
                    const sourcePath = transcriptFile(historyRoot, source);
                    const index = await indexed(sourcePath);
                    const lines =
                        index === undefined
                            ? await keptLines(((await legacyLines(legacyTranscriptFile(historyRoot, source))) ?? []).slice(0, keepRows), put)
                            : (await allLines(sourcePath, index)).slice(0, keepRows);
                    hold(lines.flatMap(blobNamesIn));
                    if (lines.length > 0) {
                        await writeLog(path, framesByTurn(lines));
                    }
                }),
            );
        },
        append: async (conversationId, messages) => {
            if (!isConversationId(conversationId) || messages.length === 0) {
                return;
            }
            await changing(conversationId, async (path, index, put) => {
                const kept = await Promise.all(messages.map((message) => keptLine(message, put)));
                remember(path, await appendLog(path, index, kept));
            });
        },
        read: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return [];
            }
            const legacy = await legacyRead(conversationId);
            if (legacy !== undefined) {
                return (await Promise.all(legacy.map((line) => rowOf(line, (parsed) => parsed)))).flat();
            }
            const path = transcriptFile(historyRoot, conversationId);
            const index = await indexed(path);
            return index === undefined ? [] : (await Promise.all((await allLines(path, index)).map((line) => rowOf(line, whole)))).flat();
        },
        rows: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return [];
            }
            const legacy = await legacyRead(conversationId);
            if (legacy !== undefined) {
                return (await Promise.all(legacy.map((line) => rowOf(line, previewOf)))).flat();
            }
            const path = transcriptFile(historyRoot, conversationId);
            const index = await indexed(path);
            return index === undefined ? [] : (await Promise.all((await allLines(path, index)).map((line) => rowOf(line, previewOf)))).flat();
        },
        window: async (conversationId, { before, turns = DEFAULT_WINDOW_TURNS, maxRows = MAX_WINDOW_ROWS, maxBytes = MAX_WINDOW_BYTES, fit }) => {
            if (!isConversationId(conversationId)) {
                return emptyPage();
            }
            const legacy = await legacyRead(conversationId);
            if (legacy !== undefined) {
                const rows = (await Promise.all(legacy.map((line) => rowOf(line, previewOf)))).map((parsed) => parsed[0] ?? { role: "notice" as const, text: "" });
                return windowOf(rows, { before, turns, maxRows, maxBytes, ...(fit === undefined ? {} : { fit }) });
            }
            const path = transcriptFile(historyRoot, conversationId);
            const index = await indexed(path);
            if (index === undefined) {
                return emptyPage();
            }
            // Row positions, the same ones `count` and `truncate` use, so `from` addresses the message a rewind would.
            return scanBack(
                async (at) => {
                    const line = await lineAt(path, index, at);
                    const parsed = await rowOf(line, previewOf);
                    // Unfitted, the stored line is what goes out, so its own length is the cost and nothing is re-measured.
                    if (fit === undefined) {
                        return { rows: parsed, bytes: line.length };
                    }
                    const fitted = parsed.map(fit);
                    return { rows: fitted, bytes: servedSize(fitted) };
                },
                pageEnd(before, index.rows),
                { turns, maxRows, maxBytes },
            );
        },
        findBack: async (conversationId, match) => {
            if (!isConversationId(conversationId)) {
                return undefined;
            }
            const legacy = await legacyRead(conversationId);
            const path = transcriptFile(historyRoot, conversationId);
            const index = legacy === undefined ? await indexed(path) : undefined;
            const count = legacy?.length ?? index?.rows ?? 0;
            for (let at = count - 1; at >= 0; at -= 1) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- newest first, and the first hit ends the search.
                const line = legacy === undefined ? await lineAt(path, index!, at) : (legacy[at] ?? "");
                const found = (await rowOf(line, calls)).find(match);
                if (found !== undefined) {
                    return found;
                }
            }
            return undefined;
        },
        count: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return 0;
            }
            const legacy = await legacyRead(conversationId);
            return legacy?.length ?? (await indexed(transcriptFile(historyRoot, conversationId)))?.rows ?? 0;
        },
        size: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return undefined;
            }
            const info =
                (await stat(transcriptFile(historyRoot, conversationId)).catch(undefinedIfMissing)) ??
                (await stat(legacyTranscriptFile(historyRoot, conversationId)).catch(undefinedIfMissing));
            return info?.size;
        },
        stored: async (conversationId) => {
            if (!isConversationId(conversationId)) {
                return [];
            }
            return (await legacyRead(conversationId)) ?? scanned(transcriptFile(historyRoot, conversationId));
        },
        sweep: (gone) => {
            const run = sweeps.then(() => sweepOnce(gone));
            // silent-catch: this sweep's caller has its rejection from `run`; the chain only orders the next sweep.
            sweeps = run.catch(() => undefined);
            return run;
        },
        truncate: async (conversationId, keepRows) => {
            if (!isConversationId(conversationId)) {
                return 0;
            }
            return changing(conversationId, async (path, index) => {
                if (index === undefined || index.rows <= keepRows) {
                    return 0;
                }
                // Whole frames before the cut stay as they are; the frame it falls in keeps its first rows.
                const { frame, line } = frameOfRow(index, keepRows);
                const kept: string[][] = [];
                for (let at = 0; at < frame; at += 1) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- frames in order.
                    kept.push([...(await linesOf(path, index, at))]);
                }
                kept.push((await linesOf(path, index, frame)).slice(0, line));
                await writeLog(path, kept);
                forget(path);
                return index.rows - keepRows;
            });
        },
    };
};
