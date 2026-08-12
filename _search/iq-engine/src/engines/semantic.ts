import type { Embedder } from "../embed/embedder.js";
import type { VectorCache } from "../embed/vector-cache.js";
import type { IndexDb } from "../store/db.js";
import { nearestChunks, putVector } from "../store/vectors.js";
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
                // The cache holds full-precision vectors; quantizing is the vector table's business, and
                // happens on the way in. Keeping the cache at float means a re-embed is never needed if the
                // stored precision ever changes.
                const blob = cached.get(hash) ?? fresh.get(hash)!;
                putVector(db, Number(row["id"]), Number(row["file_id"]), new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
            }
        });
        done += rows.length;
    }
    return Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"] ?? 0);
};

/* Rank inside SQLite, then read only what is shown.
 *
 * The shape this replaced pulled every embedded chunk — vector AND text — into JavaScript and scored them in a
 * loop, which on this workspace's index meant 98MB of vectors and 30MB of text read per query to return 24 rows
 * of answer. Three quarters of the 286ms that cost was the reading alone, and the garbage it made accounted for
 * 14.6% of the time. Here the vector table does the ranking and hands back 24 chunk ids; the text those need is
 * a second lookup of 24 rows, and the whole query is 31ms.
 *
 * Scope is pushed into that ranking rather than applied after it. Filtering the top 24 of the whole workspace
 * down to the ones in scope would answer a different question — the scoped top 24 can be nowhere near the
 * global one — so `allowed` becomes a file-id restriction the ranking itself honours. When every indexed file
 * is in scope, which is the ordinary case, there is no restriction to apply and none is built. */
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
            // Ties come back from SQLite in whatever order it walked them; the old scorer broke them by path then
            // line, and callers (and tests) depend on one query giving one answer.
            .toSorted((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1) || a.line - b.line)
            .map(({ path, line, text, score }) => ({ path, line, text, tags: [{ kind: "sem" as const, score: Math.round(score * 100) / 100 }] }))
    );
};
