import type { SqliteDb } from "@intentic/base/sqlite";
import { decayOf, matchingTitles, matchingTurns, sessionFiles } from "./files.js";
import { contentTermsOf, ftsMatchOf } from "./terms.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// A match worth putting in front of the agent is judged on an absolute scale, never against the other candidates of
// the same query: `score` calls its own best candidate near-perfect however little it shares, and raw BM25 grows with
// the prompt's length. So a prompt must name at least MIN_CONTENT_TERMS topics, and the session must cover
// STRONG_COVERAGE of their IDF weight in one turn plus its title.
// Measured on a re-ingested copy of a live recall.db (4,470 turns, preambles off): the top session of 20 off-topic prompts covered at most 0.48, of 17 of 18 paraphrased real asks at least 0.63, and a lone content term ("push") is covered in full by 418 sessions.
const MIN_CONTENT_TERMS = 2;
const STRONG_COVERAGE = 0.5;

export interface SessionMatch {
    readonly sessionId: string;
    readonly title: string | undefined;
    readonly lastTs: number;
    readonly promptCount: number;
    readonly score: number;
    readonly bm25: number;
    // Share of the prompt's content-term IDF weight this session matched in its best turn plus its title, 0..1.
    readonly coverage: number;
    readonly strong: boolean;
}

export interface MatchOptions {
    readonly days?: number;
    readonly excludeSessionId?: string;
    // Files already known relevant to the new prompt (e.g. from rankFilesForTopic), enables the overlap term.
    readonly files?: readonly string[];
}

// Per session, the share of the terms' IDF weight it matched in its best in-window turn plus its title. IDF over the
// window's turns, so a word every turn carries (the workspace's own name) is worth little and a word no turn has
// used is worth the most while matching nowhere. One indexed lookup per term: FTS5 decides what a term matches, the
// same tokenizer the OR query goes through.
const coverageBySession = (db: SqliteDb, terms: readonly string[], sinceTs: number): Map<number, number> => {
    const turnCount = Number(db.get("SELECT COUNT(*) AS n FROM turns WHERE ts >= ?", sinceTs)?.["n"] ?? 0);
    const postings = terms.map((term) =>
        db.all(
            `SELECT t.id AS id, t.session_id AS session
             FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid
             WHERE turns_fts MATCH ? AND t.ts >= ?`,
            ftsMatchOf([term]),
            sinceTs,
        ),
    );
    const weights = postings.map((rows) => Math.log(1 + (turnCount - rows.length + 0.5) / (rows.length + 0.5)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const titleTerms = new Map<number, Set<number>>();
    const titleWeight = new Map<number, number>();
    terms.forEach((term, index) => {
        for (const row of db.all("SELECT rowid AS id FROM sessions_fts WHERE sessions_fts MATCH ?", ftsMatchOf([term]))) {
            const session = Number(row["id"]);
            const seen = titleTerms.get(session) ?? new Set<number>();
            titleTerms.set(session, seen.add(index));
            titleWeight.set(session, (titleWeight.get(session) ?? 0) + weights[index]!);
        }
    });
    // A term the title already carries is not counted again for the turn.
    const turnWeight = new Map<number, { session: number; weight: number }>();
    postings.forEach((rows, index) => {
        for (const row of rows) {
            const session = Number(row["session"]);
            if (titleTerms.get(session)?.has(index) === true) {
                continue;
            }
            const turn = Number(row["id"]);
            const entry = turnWeight.get(turn) ?? { session, weight: 0 };
            entry.weight += weights[index]!;
            turnWeight.set(turn, entry);
        }
    });
    const bestTurn = new Map<number, number>();
    for (const { session, weight } of turnWeight.values()) {
        bestTurn.set(session, Math.max(bestTurn.get(session) ?? 0, weight));
    }
    const coverage = new Map<number, number>();
    for (const session of new Set([...bestTurn.keys(), ...titleWeight.keys()])) {
        coverage.set(session, ((bestTurn.get(session) ?? 0) + (titleWeight.get(session) ?? 0)) / total);
    }
    return coverage;
};

// Feature B: rank recent sessions against a new session's first prompt. Purely statistical. BM25 over
// prompts/titles + recency decay + optional file overlap orders them; content-term coverage decides which are strong.
// It works without any LLM access.
export const matchSessions = (db: SqliteDb, prompt: string, options: MatchOptions = {}): SessionMatch[] => {
    const terms = contentTermsOf(prompt);
    if (terms.length === 0) {
        return [];
    }
    const fts = ftsMatchOf(terms);
    const now = Date.now();
    const sinceTs = now - (options.days ?? 45) * DAY_MS;
    const titles = matchingTitles(db, fts);
    const bestTurn = new Map<number, number>();
    for (const turn of matchingTurns(db, fts, sinceTs)) {
        bestTurn.set(turn.sessionRowId, Math.max(bestTurn.get(turn.sessionRowId) ?? 0, turn.score));
    }
    const candidateIds = new Set([...bestTurn.keys(), ...titles.keys()]);
    if (candidateIds.size === 0) {
        return [];
    }
    interface Candidate {
        sessionRowId: number;
        sessionId: string;
        title: string | undefined;
        lastTs: number;
        promptCount: number;
        bm25: number;
    }
    const candidates: Candidate[] = [];
    for (const sessionRowId of candidateIds) {
        const row = db.get(
            `SELECT s.session_id AS sid, s.title AS title, s.last_ts AS last_ts, COUNT(t.id) AS prompts
             FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
             WHERE s.id = ? GROUP BY s.id`,
            sessionRowId,
        );
        if (row === undefined || Number(row["prompts"]) === 0 || Number(row["last_ts"]) < sinceTs) {
            continue;
        }
        const sessionId = row["sid"] as string;
        if (sessionId === options.excludeSessionId) {
            continue;
        }
        candidates.push({
            sessionRowId,
            sessionId,
            title: typeof row["title"] === "string" ? row["title"] : undefined,
            lastTs: Number(row["last_ts"]),
            promptCount: Number(row["prompts"]),
            bm25: (bestTurn.get(sessionRowId) ?? 0) + 0.5 * (titles.get(sessionRowId) ?? 0),
        });
    }
    // Reduced, not spread, candidates grows with the transcript corpus, and a spread argument list that long
    // overflows the stack (see the same fix in iq-engine's fuse).
    const maxBm25 = candidates.reduce((max, candidate) => (candidate.bm25 > max ? candidate.bm25 : max), 0);
    if (maxBm25 === 0) {
        return [];
    }
    const coverage = coverageBySession(db, terms, sinceTs);
    const overlapTarget = options.files !== undefined && options.files.length > 0 ? new Set(options.files) : undefined;
    return candidates
        .map((candidate): SessionMatch => {
            const normalized = candidate.bm25 / maxBm25;
            const recency = decayOf(candidate.lastTs, now);
            let score: number;
            if (overlapTarget === undefined) {
                score = 0.75 * normalized + 0.25 * recency;
            } else {
                const touched = sessionFiles(db, candidate.sessionRowId);
                let shared = 0;
                for (const path of overlapTarget) {
                    if (touched.has(path)) {
                        shared += 1;
                    }
                }
                score = 0.6 * normalized + 0.2 * recency + 0.2 * (shared / overlapTarget.size);
            }
            const covered = coverage.get(candidate.sessionRowId) ?? 0;
            return {
                sessionId: candidate.sessionId,
                title: candidate.title,
                lastTs: candidate.lastTs,
                promptCount: candidate.promptCount,
                score,
                bm25: candidate.bm25,
                coverage: covered,
                strong: terms.length >= MIN_CONTENT_TERMS && covered >= STRONG_COVERAGE,
            };
        })
        .toSorted((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId));
};
