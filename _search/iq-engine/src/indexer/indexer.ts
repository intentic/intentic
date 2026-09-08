import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MODEL_ID } from "../embed/embedder.js";
import type { IndexDb } from "../store/db.js";
import {
    bumpGeneration,
    deleteFile,
    generationOf,
    getMeta,
    listFiles,
    replaceFile,
    setMeta,
    type StoredFile,
    touchFile,
} from "../store/index-store.js";
import { clearVectors } from "../store/vectors.js";
import type { ChunkRow, FileEntry, SymbolRow } from "../types.js";
import { langOf } from "../workspace/scan.js";

const MAX_FILE_BYTES = 1024 * 1024;

// Bump when parse/chunk/complexity logic changes; forces a reparse, but unchanged chunks keep their embeddings.
const PARSER_VERSION = "3";

// Symbol/chunk/complexity production is injected here (ast-grep, chunker); tests can run the indexer without either.
export type ParseFile = (
    path: string,
    lang: string | undefined,
    content: string,
) => { symbols: SymbolRow[]; chunks: ChunkRow[]; complexity: number; imports: string[] };

export interface RevalidateResult {
    readonly generation: number;
    readonly fileCount: number;
    readonly changed: number;
}

const isBinary = (buf: Buffer): boolean => buf.includes(0);

// A model swap invalidates every stored vector, never the chunks; a write, so only whoever owns writing the index calls
// it.
export const syncModel = (db: IndexDb, modelDir: string | undefined): void => {
    if (modelDir === undefined) {
        return;
    }
    if (getMeta(db, "model_id") !== MODEL_ID) {
        clearVectors(db);
        setMeta(db, "model_id", MODEL_ID);
    }
};

// Cheap already-indexed test (mtime+size, no read), for the writer only: a false reject just costs a re-hash, never an
// error.
const indexed = (entry: FileEntry, previous: StoredFile | undefined): boolean =>
    previous !== undefined && Math.round(entry.mtimeMs) === previous.mtimeMs && entry.size === previous.size;

// What a reader may call stale, size-only (not mtime): a fresh worktree checkout restamps every file's mtime, which
// would otherwise read as fully unindexed. An edit keeping the byte count is missed here but still caught by the
// writer.
const knownStale = (entry: FileEntry, previous: StoredFile | undefined): boolean => previous === undefined || entry.size !== previous.size;

// Files the index doesn't match (new, changed, gone): the freshness signal for a reader that doesn't own writing the
// index, compared against its own sweep. Pure reads.
export const indexLag = (db: IndexDb, entries: readonly FileEntry[]): number => {
    const stored = listFiles(db);
    const seen = new Set<string>();
    let lag = 0;
    for (const entry of entries) {
        seen.add(entry.path);
        if (knownStale(entry, stored.get(entry.path))) {
            lag += 1;
        }
    }
    for (const path of stored.keys()) {
        if (!seen.has(path)) {
            lag += 1;
        }
    }
    return lag;
};

// Brings the index in line with the sweep: mtime+size diff, hash-confirms touched files, delete+reinsert per genuine
// change. Reads only new/changed files.
export const revalidate = async (db: IndexDb, entries: readonly FileEntry[], parse?: ParseFile): Promise<RevalidateResult> => {
    const stored = listFiles(db);
    const seen = new Set<string>();
    const reparseAll = parse !== undefined && getMeta(db, "parser_version") !== PARSER_VERSION;
    let changed = 0;
    // Oversized/binary/unreadable files keep a bare row (hash "-", no symbols/chunks) so the mtime+size diff
    // short-circuits them on the next sweep instead of re-reading every time.
    const skipEntry = (entry: FileEntry): void => {
        db.transaction(() =>
            replaceFile(
                db,
                { path: entry.path, repo: entry.repo, lang: undefined, mtimeMs: entry.mtimeMs, size: entry.size, hash: "-", complexity: 0 },
                [],
                [],
                [],
            ),
        );
        changed++;
    };
    // Apply one read file, hash/parse/sqlite are all synchronous, so results land strictly in entry order.
    const applyRead = (entry: FileEntry, previous: ReturnType<(typeof stored)["get"]>, buf: Buffer | undefined): void => {
        const lang = buf === undefined ? undefined : langOf(entry.path);
        // A recognized source file with a stray NUL is text, not binary; skipping it would blind def/ask/find too.
        if (buf === undefined || (isBinary(buf) && lang === undefined)) {
            skipEntry(entry);
            return;
        }
        const hash = createHash("sha256").update(buf).digest("hex");
        if (!reparseAll && previous !== undefined && previous.hash === hash) {
            touchFile(db, previous.id, entry.mtimeMs, entry.size);
            return;
        }
        const content = buf.includes(0) ? buf.toString("utf8").replaceAll("\0", "�") : buf.toString("utf8");
        const parsed = parse?.(entry.path, lang, content) ?? { symbols: [], chunks: [], complexity: 0, imports: [] };
        db.transaction(() =>
            replaceFile(
                db,
                { path: entry.path, repo: entry.repo, lang, mtimeMs: entry.mtimeMs, size: entry.size, hash, complexity: parsed.complexity },
                parsed.symbols,
                parsed.chunks,
                parsed.imports,
            ),
        );
        changed++;
    };
    // Partition first: unchanged files short-circuit on mtime+size; the rest need a read.
    const toRead: { entry: FileEntry; previous: ReturnType<(typeof stored)["get"]>; read: Promise<Buffer | undefined> | undefined }[] = [];
    for (const entry of entries) {
        seen.add(entry.path);
        const previous = stored.get(entry.path);
        if (!reparseAll && indexed(entry, previous)) {
            continue;
        }
        toRead.push({ entry, previous, read: undefined });
    }
    // Bounded read-ahead keeps READ_AHEAD reads in flight; unbounded fan-out would hold every buffer in memory.
    const READ_AHEAD = 16;
    for (const [index, item] of toRead.entries()) {
        for (let ahead = index; ahead < Math.min(index + READ_AHEAD, toRead.length); ahead++) {
            const upcoming = toRead[ahead]!;
            if (upcoming.read === undefined && upcoming.entry.size <= MAX_FILE_BYTES) {
                upcoming.read = readFile(upcoming.entry.abs).catch(() => undefined);
            }
        }
        if (item.entry.size > MAX_FILE_BYTES) {
            skipEntry(item.entry);
            continue;
        }
        applyRead(item.entry, item.previous, await item.read);
        item.read = undefined; // release the buffer: memory stays bounded by the window
    }
    for (const [path, file] of stored) {
        if (!seen.has(path)) {
            db.transaction(() => deleteFile(db, file.id));
            changed++;
        }
    }
    if (reparseAll) {
        setMeta(db, "parser_version", PARSER_VERSION);
    }
    const generation = changed > 0 ? bumpGeneration(db) : generationOf(db);
    return { generation, fileCount: seen.size, changed };
};
