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
    // FTS5's best snippet window over the turn's stored response, "…"-elided.
    readonly fragment: string;
    // How many other turns ran a near-identical prompt and were folded into this one; 0 for a one-off.
    readonly repeats: number;
    // The session this turn sits in: what it opened with and what it ended on.
    readonly bookends: SessionBookends | undefined;
}

// A hit alone has no provenance; bookends say what the conversation it lives in was about, so the reader need not
// re-read the transcript to judge it.
export interface SessionBookends {
    readonly first: string;
    readonly last: string;
    readonly turns: number;
}

export interface GrabOptions {
    readonly days?: number;
    readonly limit?: number;
    readonly excludeSessionId?: string;
}

// Raw hit shape from SQL, before the shaping passes add `repeats` and `bookends`.
type RankedTurn = Omit<TurnExcerpt, "repeats" | "bookends">;

// Bookend prompts are capped here: orientation, not full content.
const BOOKEND_CHARS = 200;

// Key repeated prompts collapse on: lowercased, whitespace-collapsed, digits flattened, since what varies between two
// runs of the same job is usually a number (a date, a counter). Catches repetition regardless of source.
const repeatKey = (prompt: string): string => prompt.toLowerCase().replaceAll(/\d+/g, "#").replaceAll(/\s+/g, " ").trim();

// Ranked conversation excerpts for a topic: BM25 over prompt+response × recency decay. Each hit carries the prompt,
// answer snippet, and session/turn coordinates for forking or reading the transcript.
export const grabExcerpts = (db: RecallDb, query: string, options: GrabOptions = {}): TurnExcerpt[] => {
    const fts = ftsQueryOf(query);
    if (fts === undefined) {
        return [];
    }
    const now = Date.now();
    const sinceTs = now - (options.days ?? 90) * DAY_MS;
    const ranked = db
        .all(
            `SELECT s.session_id AS sid, s.title AS title, t.ts AS ts, t.ordinal AS ordinal, t.uuid AS uuid,
                    t.prompt AS prompt, ${TURN_BM25} AS bm25, snippet(turns_fts, 1, '', '', '…', 48) AS fragment
             FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid JOIN sessions s ON s.id = t.session_id
             WHERE turns_fts MATCH ? AND t.ts >= ?`,
            fts,
            sinceTs,
        )
        .filter((row) => row["sid"] !== options.excludeSessionId)
        .map((row) => ({
            sessionId: row["sid"] as string,
            title: typeof row["title"] === "string" ? row["title"] : undefined,
            ts: Number(row["ts"]),
            ordinal: Number(row["ordinal"]),
            turnUuid: row["uuid"] as string,
            score: Number(row["bm25"]) * decayOf(Number(row["ts"]), now),
            prompt: row["prompt"] as string,
            fragment: row["fragment"] as string,
        }))
        .toSorted((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId) || a.ordinal - b.ordinal);
    const collapsed = collapseRepeats(ranked).slice(0, options.limit ?? 10);
    return withBookends(db, collapsed);
};

// Folds near-identical prompts to their best instance plus a count; input is already ranked, so the first occurrence of
// a key is the best. Collapses rather than drops, so a job repeated for a month still shows once, not ten times.
const collapseRepeats = (ranked: readonly RankedTurn[]): (RankedTurn & { repeats: number })[] => {
    const best = new Map<string, RankedTurn & { repeats: number }>();
    for (const hit of ranked) {
        const key = repeatKey(hit.prompt);
        const seen = best.get(key);
        if (seen === undefined) {
            best.set(key, { ...hit, repeats: 0 });
            continue;
        }
        seen.repeats += 1;
    }
    return [...best.values()];
};

// One query for every returned session's opening prompt, closing prompt and turn count; runs after the slice, so cost
// scales with `limit`, not the whole match set.
const withBookends = (db: RecallDb, hits: readonly Omit<TurnExcerpt, "bookends">[]): TurnExcerpt[] => {
    const ids = [...new Set(hits.map((hit) => hit.sessionId))];
    if (ids.length === 0) {
        return [];
    }
    const rows = db.all(
        `SELECT s.session_id AS sid,
                (SELECT prompt FROM turns WHERE session_id = s.id ORDER BY ordinal ASC LIMIT 1) AS first_prompt,
                (SELECT prompt FROM turns WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS last_prompt,
                (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turns
         FROM sessions s WHERE s.session_id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
    );
    const bySession = new Map<string, SessionBookends>();
    for (const row of rows) {
        const first = row["first_prompt"];
        const last = row["last_prompt"];
        if (typeof first !== "string" || typeof last !== "string") {
            continue;
        }
        bySession.set(row["sid"] as string, {
            first: first.slice(0, BOOKEND_CHARS),
            last: last.slice(0, BOOKEND_CHARS),
            turns: Number(row["turns"]),
        });
    }
    // A one-turn session's bookends are the hit itself; carries none to avoid repeating it.
    return hits.map((hit) => {
        const bookends = bySession.get(hit.sessionId);
        return { ...hit, bookends: bookends === undefined || bookends.turns <= 1 ? undefined : bookends };
    });
};
