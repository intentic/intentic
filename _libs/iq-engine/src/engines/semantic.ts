import type { Embedder } from "../embed/embedder.js";
import type { IndexDb } from "../store/db.js";
import type { EngineHit } from "../types.js";

const TOP_K = 24;
const TOPUP_CAP = 256;
const TOPUP_TIME_MS = 2000;
const BATCH = 16;

// Opportunistic embedding top-up during `iq ask`: fill NULL embeddings until the cap or time budget runs out.
// Returns how many chunks remain unembedded (0 = semantic coverage is complete).
export const embedPending = async (db: IndexDb, embedder: Embedder, cap = TOPUP_CAP, timeBudgetMs = TOPUP_TIME_MS): Promise<number> => {
    const started = Date.now();
    let done = 0;
    while (done < cap && Date.now() - started < timeBudgetMs) {
        const rows = db.all("SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT ?", Math.min(BATCH, cap - done));
        if (rows.length === 0) {
            break;
        }
        const vectors = await embedder.embedBatch(rows.map((row) => row["text"] as string));
        db.transaction(() => {
            rows.forEach((row, i) => {
                db.run(
                    "UPDATE chunks SET embedding = ? WHERE id = ?",
                    new Uint8Array(vectors[i]!.buffer.slice(vectors[i]!.byteOffset, vectors[i]!.byteOffset + vectors[i]!.byteLength)),
                    row["id"] as number,
                );
            });
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
