import type { ChunkRow, SymbolRow } from "../types.js";
import type { IndexDb } from "./db.js";

export interface StoredFile {
    readonly id: number;
    readonly path: string;
    readonly repo: string | undefined;
    readonly lang: string | undefined;
    readonly mtimeMs: number;
    readonly size: number;
    readonly hash: string;
}

export const listFiles = (db: IndexDb): Map<string, StoredFile> => {
    const map = new Map<string, StoredFile>();
    for (const row of db.all("SELECT id, path, repo, lang, mtime_ms, size, hash FROM files")) {
        map.set(row["path"] as string, {
            id: Number(row["id"]),
            path: row["path"] as string,
            repo: (row["repo"] as string | null) ?? undefined,
            lang: (row["lang"] as string | null) ?? undefined,
            mtimeMs: Number(row["mtime_ms"]),
            size: Number(row["size"]),
            hash: row["hash"] as string,
        });
    }
    return map;
};

export const touchFile = (db: IndexDb, id: number, mtimeMs: number, size: number): void => {
    db.run("UPDATE files SET mtime_ms = ?, size = ? WHERE id = ?", Math.round(mtimeMs), size, id);
};

export const deleteFile = (db: IndexDb, id: number): void => {
    db.run("DELETE FROM files WHERE id = ?", id);
};

// Replace one file's index rows in a single shape: upsert the file, drop derived rows, reinsert. Embeddings for
// unchanged chunk content are copied over by hash so renames/moves/reformats never re-embed.
export const replaceFile = (
    db: IndexDb,
    file: { path: string; repo: string | undefined; lang: string | undefined; mtimeMs: number; size: number; hash: string },
    symbols: readonly SymbolRow[],
    chunks: readonly ChunkRow[],
): void => {
    const previousEmbeddings = new Map<string, Uint8Array>();
    for (const row of db.all(
        "SELECT c.hash, c.embedding FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = ? AND c.embedding IS NOT NULL",
        file.path,
    )) {
        previousEmbeddings.set(row["hash"] as string, row["embedding"] as Uint8Array);
    }
    db.run("DELETE FROM files WHERE path = ?", file.path);
    db.run(
        "INSERT INTO files (path, repo, lang, mtime_ms, size, hash) VALUES (?, ?, ?, ?, ?, ?)",
        file.path,
        file.repo ?? null,
        file.lang ?? null,
        Math.round(file.mtimeMs),
        file.size,
        file.hash,
    );
    const id = Number(db.get("SELECT id FROM files WHERE path = ?", file.path)!["id"]);
    for (const symbol of symbols) {
        db.run(
            "INSERT INTO symbols (file_id, name, kind, line, end_line, signature, exported, heuristic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            id,
            symbol.name,
            symbol.kind,
            symbol.line,
            symbol.endLine,
            symbol.signature,
            symbol.exported ? 1 : 0,
            symbol.heuristic ? 1 : 0,
        );
    }
    for (const chunk of chunks) {
        db.run(
            "INSERT INTO chunks (file_id, start_line, end_line, hash, text, embedding) VALUES (?, ?, ?, ?, ?, ?)",
            id,
            chunk.startLine,
            chunk.endLine,
            chunk.hash,
            chunk.text,
            previousEmbeddings.get(chunk.hash) ?? null,
        );
    }
};

export const getMeta = (db: IndexDb, key: string): string | undefined =>
    db.get("SELECT value FROM meta WHERE key = ?", key)?.["value"] as string | undefined;

export const setMeta = (db: IndexDb, key: string, value: string): void => {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
};

export const bumpGeneration = (db: IndexDb): number => {
    const next = Number(getMeta(db, "generation") ?? "0") + 1;
    setMeta(db, "generation", String(next));
    return next;
};

export const generationOf = (db: IndexDb): number => Number(getMeta(db, "generation") ?? "0");
