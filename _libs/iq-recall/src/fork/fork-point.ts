import { statSync } from "node:fs";
import { join } from "node:path";
import type { RecallDb } from "../store/db.js";
import { fileIdf, rankFilesForTopic } from "../rank/files.js";

export interface ForkPoint {
    readonly turnUuid: string;
    readonly ordinal: number;
    readonly estTokens: number;
    // Query-relevant files whose content the prefix already carries, still matching disk.
    readonly coverageFiles: readonly string[];
    // Query-relevant files in the prefix that changed on disk since the session touched them.
    readonly staleFiles: readonly string[];
}

// Pick the user-turn prefix of a past session that maximizes still-valid relevant context per token:
// score(P_k) = (Σ idf(fresh relevant files) − 1.5 × Σ idf(stale relevant files)) / sqrt(tokens + 1000).
// Stale reads are penalized harder than missing ones — a fork that believes outdated file contents is worse
// than one that has to re-read. All prefixes ≤ 0 → no fork point beats starting fresh.
export const selectForkPoint = (db: RecallDb, root: string, sessionId: string, prompt?: string): ForkPoint | undefined => {
    const session = db.get("SELECT id FROM sessions WHERE session_id = ?", sessionId);
    if (session === undefined) {
        return undefined;
    }
    const sessionRowId = Number(session["id"]);
    const turns = db
        .all("SELECT id, uuid, ordinal, ts, start_byte FROM turns WHERE session_id = ? ORDER BY ordinal", sessionRowId)
        .map((row) => ({ id: Number(row["id"]), uuid: row["uuid"] as string, ordinal: Number(row["ordinal"]), startByte: Number(row["start_byte"]) }));
    if (turns.length === 0) {
        return undefined;
    }
    const transcriptSize = Number(db.get("SELECT size FROM transcripts WHERE session_id = ?", sessionId)?.["size"] ?? 0);
    const touchesByTurn = new Map<number, { path: string; lastTs: number }[]>();
    const allPaths = new Set<string>();
    for (const row of db.all(
        "SELECT tf.turn_id AS turn_id, tf.path AS path, tf.last_ts AS last_ts FROM turn_files tf JOIN turns t ON t.id = tf.turn_id WHERE t.session_id = ?",
        sessionRowId,
    )) {
        const turnId = Number(row["turn_id"]);
        const touches = touchesByTurn.get(turnId) ?? [];
        touchesByTurn.set(turnId, touches);
        touches.push({ path: row["path"] as string, lastTs: Number(row["last_ts"]) });
        allPaths.add(row["path"] as string);
    }
    const relevant =
        prompt === undefined
            ? allPaths
            : new Set(rankFilesForTopic(db, prompt, { limit: 50, days: 365 }).map((file) => file.path).filter((path) => allPaths.has(path)));
    if (relevant.size === 0) {
        return undefined;
    }
    const idf = fileIdf(db, [...relevant]);
    const mtimeOf = (path: string): number => {
        try {
            return statSync(join(root, path)).mtimeMs;
        } catch {
            // Deleted since the session — its remembered content is as misleading as a stale read.
            return Number.MAX_SAFE_INTEGER;
        }
    };
    const diskMtime = new Map([...relevant].map((path) => [path, mtimeOf(path)]));
    const covered = new Map<string, number>();
    let best: { point: ForkPoint; score: number } | undefined;
    for (const [k, turn] of turns.entries()) {
        for (const touch of touchesByTurn.get(turn.id) ?? []) {
            if (relevant.has(touch.path)) {
                covered.set(touch.path, Math.max(covered.get(touch.path) ?? 0, touch.lastTs));
            }
        }
        const fresh: string[] = [];
        const stale: string[] = [];
        for (const [path, lastTs] of covered) {
            (diskMtime.get(path)! > lastTs ? stale : fresh).push(path);
        }
        const sum = (paths: string[]): number => paths.reduce((total, path) => total + (idf.get(path) ?? 0), 0);
        const bytes = (turns[k + 1]?.startByte ?? transcriptSize) - turns[0]!.startByte;
        const estTokens = Math.round(bytes / 4);
        const score = (sum(fresh) - 1.5 * sum(stale)) / Math.sqrt(estTokens + 1000);
        if (score > 0 && (best === undefined || score > best.score)) {
            best = { point: { turnUuid: turn.uuid, ordinal: turn.ordinal, estTokens, coverageFiles: fresh.toSorted(), staleFiles: stale.toSorted() }, score };
        }
    }
    return best?.point;
};
