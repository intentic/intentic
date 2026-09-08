import type { Embedder } from "../embed/embedder.js";
import type { VectorCache } from "../embed/vector-cache.js";
import type { IndexDb } from "../store/db.js";
import { nearestChunks, putVector } from "../store/vectors.js";
import type { EngineHit } from "../types.js";

const TOP_K = 24;
const TOPUP_CAP = 256;
const TOPUP_TIME_MS = 2000;
const BATCH = 16;

// Opportunistic embedding top-up during a query: fills NULL embeddings until the cap or budget runs out, returns how
// many remain (0 = complete). Cache is checked before the model per hash; shared hashes embed once.
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
        const rows = db.all("SELECT id, file_id, hash, text FROM chunks WHERE embedded = 0 LIMIT ?", Math.min(BATCH, cap - done));
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
                // Cache stays full-precision; quantizing happens entering the vector table, so precision changes skip
                // re-embed.
                const blob = cached.get(hash) ?? fresh.get(hash)!;
                putVector(db, Number(row["id"]), Number(row["file_id"]), new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
            }
        });
        done += rows.length;
    }
    return Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"] ?? 0);
};

// Ranks inside SQLite, then reads only the shown chunks' text, instead of pulling every vector into JS. Scope is pushed
// into the ranking itself, since a global top-K can differ from the scoped one.
export const semanticSearch = (db: IndexDb, queryVec: Float32Array, allowed: ReadonlySet<string>): EngineHit[] => {
    const files = db.all("SELECT id, path FROM files");
    const allowedIds = files.filter((file) => allowed.has(file["path"] as string)).map((file) => Number(file["id"]));
    const nearest = nearestChunks(db, queryVec, TOP_K, allowedIds.length === files.length ? undefined : allowedIds);
    if (nearest.length === 0) {
        return [];
    }
    const marks = nearest.map(() => "?").join(",");
    const rows = new Map(
        db
            .all(
                `SELECT c.id, c.start_line, c.text, f.path FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id IN (${marks})`,
                ...nearest.map((hit) => hit.chunkId),
            )
            .map((row) => [Number(row["id"]), row]),
    );
    return (
        nearest
            .flatMap((hit) => {
                const row = rows.get(hit.chunkId);
                // A vector whose chunk is gone: impossible through the delete trigger, and not worth crashing over.
                if (row === undefined) {
                    return [];
                }
                const text = row["text"] as string;
                return [
                    {
                        path: row["path"] as string,
                        line: Number(row["start_line"]),
                        text: text.split("\n")[1]?.trim() ?? text.split(" § ")[1] ?? "",
                        score: hit.score,
                    },
                ];
            })
            // Ties come from SQLite in whatever order walked; broken by path then line so one query gives one answer.
            .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1) || a.line - b.line)
            .map(({ path, line, text, score }) => ({ path, line, text, tags: [{ kind: "sem" as const, score: Math.round(score * 100) / 100 }] }))
    );
};
