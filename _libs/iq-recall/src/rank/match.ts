import type { RecallDb } from "../store/db.js";
import { decayOf, ftsQueryOf, matchingTitles, matchingTurns, sessionFiles } from "./files.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixture-tuned floor for a match worth interrupting the user over: the best prompt must genuinely share
// vocabulary (raw BM25) AND the blended score must clear the bar after recency/overlap weighting.
const STRONG_BM25 = 1.5;
const STRONG_SCORE = 0.6;

export interface SessionMatch {
    readonly sessionId: string;
    readonly title: string | undefined;
    readonly lastTs: number;
    readonly promptCount: number;
    readonly score: number;
    readonly bm25: number;
    readonly strong: boolean;
}

export interface MatchOptions {
    readonly days?: number;
    readonly excludeSessionId?: string;
    // Files already known relevant to the new prompt (e.g. from rankFilesForTopic) — enables the overlap term.
    readonly files?: readonly string[];
}

// Feature B: rank recent sessions against a new session's first prompt. Purely statistical — BM25 over
// prompts/titles + recency decay + optional file overlap — so it works without any LLM access.
export const matchSessions = (db: RecallDb, prompt: string, options: MatchOptions = {}): SessionMatch[] => {
    const fts = ftsQueryOf(prompt);
    if (fts === undefined) {
        return [];
    }
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
    const maxBm25 = Math.max(...candidates.map((candidate) => candidate.bm25), 0);
    if (maxBm25 === 0) {
        return [];
    }
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
            return {
                sessionId: candidate.sessionId,
                title: candidate.title,
                lastTs: candidate.lastTs,
                promptCount: candidate.promptCount,
                score,
                bm25: candidate.bm25,
                strong: candidate.bm25 >= STRONG_BM25 && score >= STRONG_SCORE,
            };
        })
        .toSorted((a, b) => b.score - a.score || a.sessionId.localeCompare(b.sessionId));
};
