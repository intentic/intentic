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
    // FTS5's best snippet window over the turn's stored response, the answer fragment, "…"-elided.
    readonly fragment: string;
    // How many OTHER turns ran a near-identical prompt and were folded into this one. 0 for a one-off; large
    // for a nightly automation, where it is the useful fact, "this is a recurring job" rather than ten rows.
    readonly repeats: number;
    // The session this turn sits in, as its own shape: what it opened with and what it ended on.
    readonly bookends: SessionBookends | undefined;
}

// A hit says what matched; the bookends say what the conversation it lives in was ABOUT. Without them a
// mid-session hit is a sentence with no provenance, the model can see its own words came back but not whether
// the session that produced them was the throwaway one or the one that got it right, and it re-reads the whole
// transcript to find out. Borrowed from hermes-agent's session_search, which returns the same pair for the
// same reason (it calls them bookend_start / bookend_end).
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

// A hit as the SQL produced it, before the two shaping passes add `repeats` and `bookends`.
type RankedTurn = Omit<TurnExcerpt, "repeats" | "bookends">;

// Prompts are capped where they are read: a bookend is orientation, not the content itself.
const BOOKEND_CHARS = 200;

/* THE KEY REPEATED PROMPTS COLLAPSE ON. Lowercased, whitespace-collapsed, and with every run of digits
 * flattened, because the thing that varies between two fires of the same scheduled job is almost always a
 * number: the date in "daily audit for 2026-08-01", a run counter, an hour.
 *
 * This is the index-native form of a problem hermes-agent solves with a source column ("cron sessions
 * accumulate repetitive vocabulary and starve interactive sessions out of the top N under bare BM25"). We have
 * no such column and should not grow one, the recall index is a pure cache over Claude Code transcripts, and
 * teaching it which conversations the daemon started would couple this island to the daemon it deliberately
 * knows nothing about. Keying on the repetition ITSELF needs no provenance and catches the same hazard from
 * any source: a scheduled automation, a /loop, or a human who pastes the same question every morning. */
const repeatKey = (prompt: string): string => prompt.toLowerCase().replaceAll(/\d+/g, "#").replaceAll(/\s+/g, " ").trim();

// Feature C: ranked conversation excerpts for a topic, the recall analogue of a code-search hit list. BM25
// over prompts+responses × recency decay; each hit carries the typed prompt and the answer's snippet, plus
// session/turn coordinates so callers can fork or read the transcript for full context.
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

/* Fold near-identical prompts down to their best instance, carrying the count. Input is already ranked, so the
 * first occurrence of a key IS the best one and the rest only need counting.
 *
 * Collapsing rather than dropping is the whole point: a job that has run nightly for a month is still the right
 * answer to a question about what it does, and `repeats: 29` tells the reader more than 29 rows would. What it
 * must not do is spend all ten slots saying it. */
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

// One query for every returned session's opening prompt, closing prompt and turn count. Runs after the slice,
// so it costs `limit` sessions' worth of lookup rather than the whole match set's.
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
    // A one-turn session's bookends ARE the hit, saying it twice is noise, so it carries none.
    return hits.map((hit) => {
        const bookends = bySession.get(hit.sessionId);
        return { ...hit, bookends: bookends === undefined || bookends.turns <= 1 ? undefined : bookends };
    });
};
