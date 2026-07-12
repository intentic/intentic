import type { RecallDb } from "../store/db.js";

// Matches iq-engine's RECENCY_HALF_LIFE_DAYS: a two-week-old association is worth half a fresh one.
export const HALF_LIFE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export const decayOf = (ts: number, now: number): number => 2 ** (-Math.max(0, now - ts) / (HALF_LIFE_DAYS * DAY_MS));

// User text → FTS5 query: bare tokens OR-ed, each quoted so operators/punctuation can't break the parser.
// OR (not implicit AND) because prompts paraphrase — BM25 still ranks fuller matches higher.
export const ftsQueryOf = (query: string): string | undefined => {
    const tokens = query.match(/[\p{L}\p{N}_$]+/gu);
    if (tokens === null || tokens.length === 0) {
        return undefined;
    }
    return tokens.map((token) => `"${token}"`).join(" OR ");
};

const chunked = <T>(items: readonly T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
};

const inList = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

// Inverse ubiquity: files touched in nearly every session (package.json, configs) carry no topical signal.
export const fileIdf = (db: RecallDb, paths: readonly string[]): Map<string, number> => {
    const total = Number(db.get("SELECT COUNT(*) AS n FROM sessions")?.["n"] ?? 0);
    const idf = new Map<string, number>();
    for (const chunk of chunked(paths, 500)) {
        const rows = db.all(
            `SELECT tf.path AS path, COUNT(DISTINCT t.session_id) AS n
             FROM turn_files tf JOIN turns t ON t.id = tf.turn_id
             WHERE tf.path IN (${inList(chunk.length)}) GROUP BY tf.path`,
            ...chunk,
        );
        for (const row of rows) {
            idf.set(row["path"] as string, Math.log((total + 1) / (1 + Number(row["n"]))));
        }
    }
    return idf;
};

export interface MatchingTurn {
    readonly turnId: number;
    readonly sessionRowId: number;
    readonly ts: number;
    readonly score: number;
}

// Turns whose prompt matches the query, with bm25 sign-flipped to positive-better.
export const matchingTurns = (db: RecallDb, fts: string, sinceTs: number): MatchingTurn[] =>
    db
        .all(
            `SELECT t.id AS id, t.session_id AS session, t.ts AS ts, -bm25(turns_fts) AS score
             FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
             WHERE turns_fts MATCH ? AND t.ts >= ?`,
            fts,
            sinceTs,
        )
        .map((row) => ({ turnId: Number(row["id"]), sessionRowId: Number(row["session"]), ts: Number(row["ts"]), score: Number(row["score"]) }));

// Session-row-id → title bm25 score (positive-better) for sessions whose ai-title matches the query.
export const matchingTitles = (db: RecallDb, fts: string): Map<number, number> =>
    new Map(
        db
            .all(
                `SELECT s.id AS id, -bm25(sessions_fts) AS score
                 FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.rowid
                 WHERE sessions_fts MATCH ?`,
                fts,
            )
            .map((row) => [Number(row["id"]), Number(row["score"])]),
    );

export interface TopicFile {
    readonly path: string;
    readonly score: number;
    readonly sessions: number;
    readonly lastTouched: number;
    readonly sampleTitle?: string;
}

export interface TopicOptions {
    readonly days?: number;
    readonly limit?: number;
}

// Feature A: files that past sessions associated with this topic, ranked by prompt/title BM25 × recency
// decay × inverse ubiquity, with modified files weighted over merely-read ones.
export const rankFilesForTopic = (db: RecallDb, query: string, options: TopicOptions = {}): TopicFile[] => {
    const fts = ftsQueryOf(query);
    if (fts === undefined) {
        return [];
    }
    const now = Date.now();
    const sinceTs = now - (options.days ?? 90) * DAY_MS;
    const turns = matchingTurns(db, fts, sinceTs);
    if (turns.length === 0) {
        return [];
    }
    const titles = matchingTitles(db, fts);
    interface Accumulated {
        score: number;
        sessions: Set<number>;
        lastTouched: number;
        bestContribution: number;
        bestSession: number;
    }
    const byPath = new Map<string, Accumulated>();
    for (const chunk of chunked(turns, 500)) {
        const byTurnId = new Map(chunk.map((turn) => [turn.turnId, turn]));
        const rows = db.all(
            `SELECT turn_id, path, modified, last_ts FROM turn_files WHERE turn_id IN (${inList(chunk.length)})`,
            ...chunk.map((turn) => turn.turnId),
        );
        for (const row of rows) {
            const turn = byTurnId.get(Number(row["turn_id"]))!;
            const contribution = (turn.score + 0.5 * (titles.get(turn.sessionRowId) ?? 0)) * decayOf(turn.ts, now) * (Number(row["modified"]) === 1 ? 1.25 : 1);
            const path = row["path"] as string;
            const accumulated = byPath.get(path) ?? { score: 0, sessions: new Set<number>(), lastTouched: 0, bestContribution: 0, bestSession: 0 };
            byPath.set(path, accumulated);
            accumulated.score += contribution;
            accumulated.sessions.add(turn.sessionRowId);
            accumulated.lastTouched = Math.max(accumulated.lastTouched, Number(row["last_ts"]));
            if (contribution > accumulated.bestContribution) {
                accumulated.bestContribution = contribution;
                accumulated.bestSession = turn.sessionRowId;
            }
        }
    }
    const idf = fileIdf(db, [...byPath.keys()]);
    const titleOf = (sessionRowId: number): string | undefined => {
        const title = db.get("SELECT title FROM sessions WHERE id = ?", sessionRowId)?.["title"];
        return typeof title === "string" ? title : undefined;
    };
    return [...byPath.entries()]
        .map(([path, accumulated]): TopicFile => {
            const sampleTitle = titleOf(accumulated.bestSession);
            return {
                path,
                score: accumulated.score * (idf.get(path) ?? 0),
                sessions: accumulated.sessions.size,
                lastTouched: accumulated.lastTouched,
                ...(sampleTitle !== undefined ? { sampleTitle } : {}),
            };
        })
        .filter((file) => file.score > 0)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, options.limit ?? 20);
};

// All distinct files a session touched (workspace-relative).
export const sessionFiles = (db: RecallDb, sessionRowId: number): Set<string> =>
    new Set(
        db
            .all("SELECT DISTINCT tf.path AS path FROM turn_files tf JOIN turns t ON t.id = tf.turn_id WHERE t.session_id = ?", sessionRowId)
            .map((row) => row["path"] as string),
    );
