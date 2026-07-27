import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MODEL_ID } from "../embed/embedder.js";
import type { IndexDb } from "../store/db.js";
import { bumpGeneration, deleteFile, generationOf, getMeta, listFiles, replaceFile, setMeta, touchFile } from "../store/index-store.js";
import type { ChunkRow, FileEntry, SymbolRow } from "../types.js";
import { langOf } from "../workspace/scan.js";

const MAX_FILE_BYTES = 1024 * 1024;

// Bumped when symbol-extraction/chunking/complexity logic changes: every file is reparsed on the next
// revalidation, but unlike a schema bump the DB survives, so unchanged chunks keep their embeddings (hash reuse
// in replaceFile).
const PARSER_VERSION = "3";

// Symbol/chunk/complexity production is injected: the structural (ast-grep) and semantic (chunker) stages plug
// in here, and tests can run the indexer without either.
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

// A model swap invalidates every stored vector, never the chunks themselves. A WRITE, so it belongs to whoever
// owns writing the index — the CLI engine's own revalidation pass, or the daemon's index worker.
export const syncModel = (db: IndexDb, modelDir: string | undefined): void => {
    if (modelDir === undefined) {
        return;
    }
    if (getMeta(db, "model_id") !== MODEL_ID) {
        db.run("UPDATE chunks SET embedding = NULL");
        setMeta(db, "model_id", MODEL_ID);
    }
};

// Bring the index in line with the sweep: mtime+size diff, content-hash confirmation for touched files, and a
// transactional delete+reinsert per genuinely changed file. Read cost is paid only for new/changed files.
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
    // Apply one read file — hash/parse/sqlite are all synchronous, so results land strictly in entry order.
    const applyRead = (entry: FileEntry, previous: ReturnType<(typeof stored)["get"]>, buf: Buffer | undefined): void => {
        const lang = buf === undefined ? undefined : langOf(entry.path);
        // A recognized source file is text with a stray NUL, not a binary — skipping it would make the file
        // invisible to def/ask/find alike (ripgrep already goes blind on it; the index must not).
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
    // Partition first: unchanged files short-circuit on mtime+size exactly as before; the rest need a read.
    const toRead: { entry: FileEntry; previous: ReturnType<(typeof stored)["get"]>; read: Promise<Buffer | undefined> | undefined }[] = [];
    for (const entry of entries) {
        seen.add(entry.path);
        const previous = stored.get(entry.path);
        if (!reparseAll && previous !== undefined && Math.round(entry.mtimeMs) === previous.mtimeMs && entry.size === previous.size) {
            continue;
        }
        toRead.push({ entry, previous, read: undefined });
    }
    // Bounded read-ahead: keep up to READ_AHEAD readFile()s in flight while results are consumed in order. On a
    // cold build (or a PARSER_VERSION bump) this reads the entire workspace — serial reads dominate that path,
    // while an unbounded fan-out would hold every file buffer in memory at once.
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
        item.read = undefined; // release the buffer — memory stays bounded by the window
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
