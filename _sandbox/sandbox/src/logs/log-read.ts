import { type FileHandle, open } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { isJsonObject, type JsonObject } from "../store/evolution/conversions.js";

// Reads a JSONL log newest line first, backwards from its end in chunks, and stops at the first line older than the
// window asked for. A question about the last hour of a 40 MB file reads the last hour, and nothing older ever enters
// memory. A log pruneLogFiles rotates (log-files.ts) is read on into its older segment when the window reaches past
// the live file's first line.

const CHUNK_BYTES = 256 * 1024;
// Lines are appended by several writers (two daemon pids across a restart, a perf span stamped at its start), so a
// line slightly older than the window does not yet mean everything before it is older too.
const ORDER_SLACK_MS = 5_000;

// The timestamp of a line without parsing it: `time` (pino) or `at` (resource samples, activity, restarts), as an ISO
// string or epoch ms. A key, so a quote must precede it; `"format":` never matches `"at":`.
const STAMP = /"(?:time|at)":(?:"([^"]+)"|(\d+))/;

export const stampOf = (raw: string): number | undefined => {
    const found = STAMP.exec(raw);
    if (found === null) {
        return undefined;
    }
    const value = found[1] !== undefined ? Date.parse(found[1]) : Number(found[2]);
    return Number.isNaN(value) ? undefined : value;
};

export interface ScanQuery {
    // Oldest stamp wanted, epoch ms; undefined reads back to the start of the oldest file (or the budget).
    readonly sinceMs?: number | undefined;
    // Bytes read across every file before giving up on the rest of the window.
    readonly budgetBytes: number;
}

export interface ScanCoverage {
    // Files that existed and were read from, newest first.
    readonly files: readonly string[];
    readonly readBytes: number;
    // Oldest and newest stamps among the lines read, epoch ms; undefined when no line carried one.
    readonly oldestAt: number | undefined;
    readonly newestAt: number | undefined;
    // How the read ended: `window` passed the window's start (so older lines exist), `start` read every file whole
    // (`oldestAt` is the oldest line kept anywhere), `budget` gave up with part of the window unread.
    readonly ended: "window" | "start" | "budget";
}

interface ScanState {
    readBytes: number;
    oldestAt: number | undefined;
    newestAt: number | undefined;
}

type Visit = (raw: string, at: number | undefined) => void;

type FileEnd = "done" | "window" | "budget";

// One line, newest first: stamped, checked against the window, and handed on. Answers whether the window has ended.
const emitLine = (bytes: Buffer, query: ScanQuery, state: ScanState, visit: Visit): boolean => {
    if (bytes.length === 0) {
        return false;
    }
    const raw = bytes.toString("utf8");
    const at = stampOf(raw);
    if (at !== undefined) {
        state.oldestAt = Math.min(state.oldestAt ?? at, at);
        state.newestAt = Math.max(state.newestAt ?? at, at);
        if (query.sinceMs !== undefined && at < query.sinceMs) {
            return at < query.sinceMs - ORDER_SLACK_MS;
        }
    }
    visit(raw, at);
    return false;
};

const scanHandle = async (handle: FileHandle, query: ScanQuery, state: ScanState, visit: Visit): Promise<FileEnd> => {
    let position = (await handle.stat()).size;
    // The bytes before the first line break seen so far: the end of a line whose start lies in the next chunk back.
    let carry = Buffer.alloc(0);
    while (position > 0) {
        if (state.readBytes >= query.budgetBytes) {
            return "budget";
        }
        const length = Math.min(CHUNK_BYTES, position, query.budgetBytes - state.readBytes);
        position -= length;
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, position);
        state.readBytes += length;
        const joined = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]);
        let end = joined.length;
        // `end > 0` first: lastIndexOf counts a negative offset from the end, which would read the chunk again.
        for (let newline = end > 0 ? joined.lastIndexOf(0x0a, end - 1) : -1; newline !== -1; newline = end > 0 ? joined.lastIndexOf(0x0a, end - 1) : -1) {
            if (emitLine(joined.subarray(newline + 1, end), query, state, visit)) {
                return "window";
            }
            end = newline;
        }
        carry = joined.subarray(0, end);
    }
    return emitLine(carry, query, state, visit) ? "window" : "done";
};

/** Hands `visit` every line of `paths` (the live file first, then its older segments) inside the window, newest first. */
export const scanNewestFirst = async (paths: readonly string[], query: ScanQuery, visit: Visit): Promise<ScanCoverage> => {
    const state: ScanState = { readBytes: 0, oldestAt: undefined, newestAt: undefined };
    const files: string[] = [];
    let ended: ScanCoverage["ended"] = "start";
    for (const path of paths) {
        // Only absence is a quiet log; one that failed to open (EACCES, a directory) throws rather than answering empty.
        const handle = await open(path, "r").catch(undefinedIfMissing);
        if (handle === undefined) {
            continue;
        }
        files.push(path);
        let end: FileEnd;
        try {
            end = await scanHandle(handle, query, state, visit);
        } finally {
            await handle.close();
        }
        if (end !== "done") {
            ended = end;
            break;
        }
    }
    return { files, readBytes: state.readBytes, oldestAt: state.oldestAt, newestAt: state.newestAt, ended };
};

/** One log line as a record, or undefined for a torn line or anything not a JSON object. */
export const parseRecord = (raw: string): JsonObject | undefined => {
    try {
        const parsed: unknown = JSON.parse(raw);
        return isJsonObject(parsed) ? parsed : undefined;
    } catch {
        // allow(silent-catch): a torn line (a truncating prune racing an append) loses one line, never the read.
        return undefined;
    }
};
