import type { IndexDb } from "./db.js";

// Writes chunk embeddings into chunk_vectors and answers nearest-neighbor queries against them. Ranking runs inside
// SQLite via sqlite-vec rather than scoring vectors in JavaScript.

// vec0 columns have no type affinity; a JS number binds as a double and is rejected, so ids must be BigInt.
const asInt = (value: number): bigint => BigInt(Math.trunc(value));

// Stretches each vector so its largest component reaches ±1 before quantizing to int8, since cosine measures only
// direction and per-vector scaling avoids clipping or wasted range.
const stretch = (vec: Float32Array): Uint8Array => {
    const out = new Float32Array(vec.length);
    let peak = 0;
    for (const value of vec) {
        peak = Math.max(peak, Math.abs(value));
    }
    // A zero vector has no direction to preserve; it stays zero and never ranks.
    const factor = peak > 0 ? 1 / peak : 0;
    for (let i = 0; i < vec.length; i++) {
        out[i] = vec[i]! * factor;
    }
    return new Uint8Array(out.buffer);
};

/** Stores a freshly computed embedding for `chunkId` and marks the chunk embedded. */
export const putVector = (db: IndexDb, chunkId: number, fileId: number, vec: Float32Array): void => {
    db.run(
        "INSERT INTO chunk_vectors (chunk_id, embedding, file_id) VALUES (?, vec_quantize_int8(?, 'unit'), ?)",
        asInt(chunkId),
        stretch(vec),
        asInt(fileId),
    );
    db.run("UPDATE chunks SET embedded = 1 WHERE id = ?", chunkId);
};

/**
 * Re-stores an already-quantized vector on the reindex path, when a chunk's text (and so its embedding) is unchanged.
 */
export const copyVector = (db: IndexDb, chunkId: number, fileId: number, quantized: Uint8Array): void => {
    // vec_int8 is required here: sqlite-vec infers element type from blob length, and 384 bytes would misread as 96
    // floats.
    db.run("INSERT INTO chunk_vectors (chunk_id, embedding, file_id) VALUES (?, vec_int8(?), ?)", asInt(chunkId), quantized, asInt(fileId));
    db.run("UPDATE chunks SET embedded = 1 WHERE id = ?", chunkId);
};

/** Stored vectors of one file's chunks, keyed by chunk hash; what replaceFile carries across a reindex. */
export const vectorsOfFile = (db: IndexDb, path: string): Map<string, Uint8Array> => {
    const vectors = new Map<string, Uint8Array>();
    for (const row of db.all(
        "SELECT c.hash, v.embedding FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id JOIN files f ON f.id = c.file_id WHERE f.path = ?",
        path,
    )) {
        vectors.set(row["hash"] as string, row["embedding"] as Uint8Array);
    }
    return vectors;
};

/** Drops every stored vector; a model swap invalidates all of them at once. */
export const clearVectors = (db: IndexDb): void => {
    db.run("DELETE FROM chunk_vectors");
    db.run("UPDATE chunks SET embedded = 0");
};

export interface VectorHit {
    readonly chunkId: number;
    /** Cosine similarity on the float scorer's scale: 1 is identical, 0 unrelated. */
    readonly score: number;
}

/**
 * The `k` nearest chunks to `queryVec`, restricted to `allowedFileIds` when given; pass undefined to search every
 * indexed file.
 */
export const nearestChunks = (db: IndexDb, queryVec: Float32Array, k: number, allowedFileIds: readonly number[] | undefined): VectorHit[] => {
    if (allowedFileIds?.length === 0) {
        return [];
    }
    // Ids are inlined, not bound: bound-parameter counts vary per query, and a scope list can run into the thousands.
    const scope = allowedFileIds === undefined ? "" : ` AND file_id IN (${allowedFileIds.map((id) => Math.trunc(id)).join(",")})`;
    return db
        .all(
            `SELECT chunk_id, distance FROM chunk_vectors WHERE embedding MATCH vec_quantize_int8(?, 'unit') AND k = ?${scope} ORDER BY distance`,
            stretch(queryVec),
            asInt(k),
        )
        .map((row) => ({ chunkId: Number(row["chunk_id"]), score: 1 - Number(row["distance"]) }));
};
