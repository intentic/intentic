import type { Embedder } from "../embed/embedder.js";
import type { VectorCache } from "../embed/vector-cache.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit } from "../types.js";

const TOP_K = 24;
const TOPUP_CAP = 256;
const TOPUP_TIME_MS = 2000;
const BATCH = 16;

// Opportunistic embedding top-up during a natural-language query: fill NULL embeddings until the cap or time budget runs out.
// Returns how many chunks remain unembedded (0 = semantic coverage is complete).
//
// The cache is consulted per chunk hash BEFORE the model: a rebuilt index refills from vectors computed in a
// previous life at SQLite speed, and only text the cache has never seen pays for inference. Chunks that share a
// hash (identical text in two places) are embedded once and fan out.
export const embedPending = async (
    db: IndexDb,
    embedder: Embedder,
    cache?: VectorCache,
    cap = TOPUP_CAP,
    timeBudgetMs = TOPUP_TIME_MS,
): Promise<number> => {
    const started = Date.now();
    let done = 0;
    while (done < cap && Date.now() - started < timeBudgetMs) {
        const rows = db.all("SELECT id, hash, text FROM chunks WHERE embedding IS NULL LIMIT ?", Math.min(BATCH, cap - done));
        if (rows.length === 0) {
            break;
        }
        const cached = cache?.get(rows.map((row) => row["hash"] as string)) ?? new Map<string, Uint8Array>();
        const missing = new Map<string, string>();
        for (const row of rows) {
            const hash = row["hash"] as string;
            if (!cached.has(hash)) {
                missing.set(hash, row["text"] as string);
            }
        }
        const misses = [...missing.entries()];
        const vectors = misses.length > 0 ? await embedder.embedBatch(misses.map(([, text]) => text)) : [];
        const fresh = new Map<string, Uint8Array>();
        misses.forEach(([hash], i) => {
            const vec = vectors[i]!;
            fresh.set(hash, new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)));
        });
        cache?.put(fresh);
        db.transaction(() => {
            for (const row of rows) {
                const hash = row["hash"] as string;
                db.run("UPDATE chunks SET embedding = ? WHERE id = ?", cached.get(hash) ?? fresh.get(hash)!, row["id"] as number);
            }
        });
        done += rows.length;
    }
    return Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NULL")?.["n"] ?? 0);
};

// Brute-force dot product over all embedded chunks — at ≤30k×384 this is milliseconds, no ANN index needed.
export const semanticSearch = (db: IndexDb, queryVec: Float32Array, allowed: ReadonlySet<string>): EngineHit[] => {
    const scored: { path: string; line: number; text: string; score: number }[] = [];
    for (const row of db.all(
        "SELECT f.path, c.start_line, c.text, c.embedding FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.embedding IS NOT NULL",
    )) {
        const path = row["path"] as string;
        if (!allowed.has(path)) {
            continue;
        }
        const blob = row["embedding"] as Uint8Array;
        const vec = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
        let dot = 0;
        for (let i = 0; i < queryVec.length; i++) {
            dot += queryVec[i]! * vec[i]!;
        }
        const text = (row["text"] as string).split("\n")[1]?.trim() ?? (row["text"] as string).split(" § ")[1] ?? "";
        scored.push({ path, line: Number(row["start_line"]), text, score: dot });
    }
    return scored
        .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1) || a.line - b.line)
        .slice(0, TOP_K)
        .map(({ path, line, text, score }) => ({ path, line, text, tags: [{ kind: "sem" as const, score: Math.round(score * 100) / 100 }] }));
};
