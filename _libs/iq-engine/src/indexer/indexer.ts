import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IndexDb } from "../store/db.js";
import { bumpGeneration, deleteFile, generationOf, getMeta, listFiles, replaceFile, setMeta, touchFile } from "../store/index-store.js";
import type { ChunkRow, FileEntry, SymbolRow } from "../types.js";
import { langOf } from "../workspace/scan.js";

const MAX_FILE_BYTES = 1024 * 1024;

// Bumped when symbol-extraction/chunking logic changes: every file is reparsed on the next revalidation, but
// unlike a schema bump the DB survives, so unchanged chunks keep their embeddings (hash reuse in replaceFile).
const PARSER_VERSION = "2";

// Symbol/chunk production is injected: the structural (ast-grep) and semantic (chunker) stages plug in here,
// and tests can run the indexer without either.
export type ParseFile = (path: string, lang: string | undefined, content: string) => { symbols: SymbolRow[]; chunks: ChunkRow[] };

export interface RevalidateResult {
    readonly generation: number;
    readonly fileCount: number;
    readonly changed: number;
}

const isBinary = (buf: Buffer): boolean => buf.includes(0);

// Bring the index in line with the sweep: mtime+size diff, content-hash confirmation for touched files, and a
// transactional delete+reinsert per genuinely changed file. Read cost is paid only for new/changed files.
export const revalidate = async (db: IndexDb, entries: readonly FileEntry[], parse?: ParseFile): Promise<RevalidateResult> => {
    const stored = listFiles(db);
    const seen = new Set<string>();
    const reparseAll = parse !== undefined && getMeta(db, "parser_version") !== PARSER_VERSION;
    let changed = 0;
    for (const entry of entries) {
        seen.add(entry.path);
        const previous = stored.get(entry.path);
        if (!reparseAll && previous !== undefined && Math.round(entry.mtimeMs) === previous.mtimeMs && entry.size === previous.size) {
            continue;
        }
        // Oversized/binary/unreadable files keep a bare row (hash "-", no symbols/chunks) so the mtime+size diff
        // short-circuits them on the next sweep instead of re-reading every time.
        const skip = (): void => {
            db.transaction(() =>
                replaceFile(db, { path: entry.path, repo: entry.repo, lang: undefined, mtimeMs: entry.mtimeMs, size: entry.size, hash: "-" }, [], []),
            );
            changed++;
        };
        if (entry.size > MAX_FILE_BYTES) {
            skip();
            continue;
        }
        const buf = await readFile(entry.abs).catch(() => undefined);
        const lang = buf === undefined ? undefined : langOf(entry.path);
        // A recognized source file is text with a stray NUL, not a binary — skipping it would make the file
        // invisible to def/ask/find alike (ripgrep already goes blind on it; the index must not).
        if (buf === undefined || (isBinary(buf) && lang === undefined)) {
            skip();
            continue;
        }
        const hash = createHash("sha256").update(buf).digest("hex");
        if (!reparseAll && previous !== undefined && previous.hash === hash) {
            touchFile(db, previous.id, entry.mtimeMs, entry.size);
            continue;
        }
        const content = buf.includes(0) ? buf.toString("utf8").replaceAll("\0", "�") : buf.toString("utf8");
        const parsed = parse?.(entry.path, lang, content) ?? { symbols: [], chunks: [] };
        db.transaction(() =>
            replaceFile(
                db,
                { path: entry.path, repo: entry.repo, lang, mtimeMs: entry.mtimeMs, size: entry.size, hash },
                parsed.symbols,
                parsed.chunks,
            ),
        );
        changed++;
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
