import { randomUUID } from "node:crypto";
import { undefinedIfMissing } from "@intentic/base/errors";
import { constants, zstdCompressSync } from "node:zlib";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { openLog, readFrame, writeLog } from "./record-log.js";
import { keptLine } from "./record-rows.js";

// Turning a plain JSONL record into the log (record-log.ts): the one conversion this format asks of records written
// before it, run once per record by the migration (record-migration.ts) and by the record itself when it must change
// one the migration has not reached. The original is kept, compressed, where the backups of the history volume go.

export const backupsRoot = (historyRoot: string): string => join(historyRoot, "backups", "transcripts");

// Where one conversation's original record is kept once converted; `zstdcat` reads it back byte for byte.
export const backupFile = (historyRoot: string, conversationId: string): string => join(backupsRoot(historyRoot), `${conversationId}.jsonl.zst`);

// Frames for a record's lines: a new one at each opening user row, so a converted record reads turn by turn.
export const framesByTurn = (lines: readonly string[]): string[][] => {
    const frames: string[][] = [];
    for (const line of lines) {
        if (line.startsWith(`{"role":"user"`) || frames.length === 0) {
            frames.push([]);
        }
        frames.at(-1)?.push(line);
    }
    return frames;
};

// Stores one long output out of line, answering its blob's name (record-blobs.ts putBlob, or a record's own).
export type PutBlob = (text: string) => Promise<string>;

// Each line as the log keeps it: a row's long outputs moved out of line through `put`, any line that is not a row as it
// was, so row positions (a checkpoint's, a rewind's) mean the same after as before.
export const keptLines = async (lines: readonly string[], put: PutBlob): Promise<string[]> =>
    Promise.all(
        lines.map(async (line) => {
            let row: TranscriptRow;
            try {
                row = JSON.parse(line) as TranscriptRow;
            } catch {
                return line;
            }
            return keptLine(row, put);
        }),
    );

export interface Converted {
    readonly rows: number;
    // What the legacy record was when read: the conversion stands only for that record.
    readonly size: number;
    readonly mtimeMs: number;
}

// Writes `bytes` zstd-compressed to `path`, durable before this resolves, never leaving a half-written file there.
const writeCompressed = async (path: string, bytes: Buffer): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "w");
    try {
        await handle.write(zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 6, [constants.ZSTD_c_checksumFlag]: 1 } }));
        await handle.datasync();
    } finally {
        await handle.close();
    }
    await rename(temporary, path);
};

export interface Conversion {
    readonly historyRoot: string;
    readonly conversationId: string;
    readonly legacy: string;
    readonly target: string;
    readonly put: PutBlob;
}

// Writes the log for the legacy record at `legacy` to `target` and the record's backup, checking the log reads back
// line for line before answering; undefined when there is no legacy record.
export const convertLegacy = async ({ historyRoot, conversationId, legacy, target, put }: Conversion): Promise<Converted | undefined> => {
    const before = await stat(legacy).catch(undefinedIfMissing);
    const raw = await readFile(legacy).catch(undefinedIfMissing);
    if (before === undefined || raw === undefined) {
        return undefined;
    }
    const kept = await keptLines(
        raw
            .toString("utf8")
            .split("\n")
            .filter((line) => line.length > 0),
        put,
    );
    await writeLog(target, framesByTurn(kept));
    const index = await openLog(target);
    const read: string[] = [];
    for (const frame of index?.frames ?? []) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- frames in order, compared as a whole below.
        read.push(...(await readFrame(target, frame)));
    }
    if (read.length !== kept.length || read.some((line, at) => line !== kept[at])) {
        await rm(target, { force: true });
        throw new Error("the converted record did not read back as written");
    }
    await writeCompressed(backupFile(historyRoot, conversationId), raw);
    return { rows: kept.length, size: before.size, mtimeMs: before.mtimeMs };
};
