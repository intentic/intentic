import type { RecallDb } from "../store/db.js";
import { decayOf, ftsQueryOf, TURN_BM25 } from "./files.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TurnExcerpt {
    readonly sessionId: string;
    readonly title: string | undefined;
    readonly ts: number;
    readonly ordinal: number;
    readonly turnUuid: string;
    readonly score: number;
    readonly prompt: string;
    // FTS5's best snippet window over the turn's stored response — the answer fragment, "…"-elided.
    readonly fragment: string;
}

export interface GrabOptions {
    readonly days?: number;
    readonly limit?: number;
    readonly excludeSessionId?: string;
}

// Feature C: ranked conversation excerpts for a topic — the recall analogue of a code-search hit list. BM25
// over prompts+responses × recency decay; each hit carries the typed prompt and the answer's snippet, plus
// session/turn coordinates so callers can fork or read the transcript for full context.
export const grabExcerpts = (db: RecallDb, query: string, options: GrabOptions = {}): TurnExcerpt[] => {
    const fts = ftsQueryOf(query);
    if (fts === undefined) {
        return [];
    }
    const now = Date.now();
    const sinceTs = now - (options.days ?? 90) * DAY_MS;
    return db
        .all(
            `SELECT s.session_id AS sid, s.title AS title, t.ts AS ts, t.ordinal AS ordinal, t.uuid AS uuid,
                    t.prompt AS prompt, ${TURN_BM25} AS bm25, snippet(turns_fts, 1, '', '', '…', 48) AS fragment
             FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid JOIN sessions s ON s.id = t.session_id
             WHERE turns_fts MATCH ? AND t.ts >= ?`,
            fts,
            sinceTs,
        )
        .filter((row) => row["sid"] !== options.excludeSessionId)
        .map(
            (row): TurnExcerpt => ({
                sessionId: row["sid"] as string,
                title: typeof row["title"] === "string" ? row["title"] : undefined,
                ts: Number(row["ts"]),
                ordinal: Number(row["ordinal"]),
                turnUuid: row["uuid"] as string,
                score: Number(row["bm25"]) * decayOf(Number(row["ts"]), now),
                prompt: row["prompt"] as string,
                fragment: row["fragment"] as string,
            }),
        )
        .toSorted((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId) || a.ordinal - b.ordinal)
        .slice(0, options.limit ?? 10);
};
