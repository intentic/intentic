import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { selectForkPoint } from "./fork/fork-point.js";
import { materializeFork } from "./fork/fork.js";
import { ingest } from "./ingest/ingest.js";
import { ftsQueryOf, rankFilesForTopic } from "./rank/files.js";
import { grabExcerpts } from "./rank/grab.js";
import { matchSessions } from "./rank/match.js";
import { openRecallDb, type RecallDb } from "./store/db.js";
import { projectsDirOf } from "./transcript/slug.js";
import type { IngestStats } from "./ingest/ingest.js";
import type { TopicFile, TopicOptions } from "./rank/files.js";
import type { GrabOptions, TurnExcerpt } from "./rank/grab.js";
import type { MatchOptions, SessionMatch } from "./rank/match.js";
import type { ForkPoint } from "./fork/fork-point.js";
import type { ForkResult } from "./fork/fork.js";

export type { ForkPoint } from "./fork/fork-point.js";
export type { ForkResult } from "./fork/fork.js";
export type { IngestStats } from "./ingest/ingest.js";
export type { GrabOptions, SessionBookends, TurnExcerpt } from "./rank/grab.js";
export type { MatchOptions, SessionMatch } from "./rank/match.js";
export type { TopicFile, TopicOptions } from "./rank/files.js";
export { readLines } from "./transcript/line-reader.js";
export { parseLine, typedPromptOf } from "./transcript/lines.js";
export { projectsDirOf } from "./transcript/slug.js";

export interface RecallOptions {
    readonly root: string;
    // Override ~/.claude (tests point this at a fixture dir).
    readonly claudeDir?: string;
    readonly dbPath?: string;
}

export interface SessionSummary {
    readonly sessionId: string;
    readonly title: string | undefined;
    readonly lastTs: number;
    readonly promptCount: number;
}

export interface Recall {
    ingest(): Promise<IngestStats>;
    filesForTopic(query: string, options?: TopicOptions): TopicFile[];
    match(prompt: string, options?: MatchOptions): SessionMatch[];
    grab(query: string, options?: GrabOptions): TurnExcerpt[];
    forkPoint(sessionId: string, prompt?: string): ForkPoint | undefined;
    // `at` is a turn uuid or a turn ordinal (digits); omitted = fork the whole session.
    fork(sessionId: string, options?: { at?: string; dryRun?: boolean }): Promise<ForkResult>;
    sessions(options?: { query?: string; days?: number; limit?: number }): SessionSummary[];
    transcriptPathOf(sessionId: string): string;
    close(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const createRecall = (options: RecallOptions): Recall => {
    const projectsDir = projectsDirOf(options.root, options.claudeDir);
    // Mirrors iq-engine's IQ_DIR ("<root>/.intentic/local/cache/iq") without dragging its heavy dependency tree in for
    // one constant, recall.db sits next to index.db, inside the dir iq already excludes from search.
    const dbPath = options.dbPath ?? join(options.root, `${STATE_DIR}/local/cache/iq/recall.db`);
    let opened: RecallDb | undefined;
    const db = (): RecallDb => (opened ??= openRecallDb(dbPath));
    return {
        ingest: () => ingest(db(), { root: options.root, projectsDir }),
        filesForTopic: (query, topicOptions) => rankFilesForTopic(db(), query, topicOptions),
        match: (prompt, matchOptions) => matchSessions(db(), prompt, matchOptions),
        grab: (query, grabOptions) => grabExcerpts(db(), query, grabOptions),
        forkPoint: (sessionId, prompt) => selectForkPoint(db(), options.root, sessionId, prompt),
        fork(sessionId, forkOptions = {}) {
            let atTurnUuid = forkOptions.at;
            if (atTurnUuid !== undefined && /^\d+$/.test(atTurnUuid)) {
                const row = db().get(
                    "SELECT t.uuid AS uuid FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ? AND t.ordinal = ?",
                    sessionId,
                    Number(atTurnUuid),
                );
                if (row === undefined) {
                    throw new Error(`session ${sessionId} has no turn ${atTurnUuid}`);
                }
                atTurnUuid = row["uuid"] as string;
            }
            return materializeFork({
                transcriptPath: this.transcriptPathOf(sessionId),
                ...(atTurnUuid !== undefined ? { atTurnUuid } : {}),
                ...(forkOptions.dryRun !== undefined ? { dryRun: forkOptions.dryRun } : {}),
            });
        },
        sessions(listOptions = {}) {
            const sinceTs = Date.now() - (listOptions.days ?? 45) * DAY_MS;
            const fts = listOptions.query === undefined ? undefined : ftsQueryOf(listOptions.query);
            const filter =
                fts === undefined
                    ? undefined
                    : new Set([
                          ...db()
                              .all("SELECT t.session_id AS id FROM turns_fts JOIN turns t ON t.id = turns_fts.rowid WHERE turns_fts MATCH ?", fts)
                              .map((row) => Number(row["id"])),
                          ...db()
                              .all("SELECT s.id AS id FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.rowid WHERE sessions_fts MATCH ?", fts)
                              .map((row) => Number(row["id"])),
                      ]);
            return (
                db()
                    .all(
                        `SELECT s.id AS id, s.session_id AS sid, s.title AS title, s.last_ts AS last_ts, COUNT(t.id) AS prompts
                     FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
                     WHERE s.last_ts >= ? GROUP BY s.id HAVING COUNT(t.id) > 0 ORDER BY s.last_ts DESC`,
                        sinceTs,
                    )
                    .filter((row) => filter === undefined || filter.has(Number(row["id"])))
                    // Sliced after the FTS filter, not in SQL: the filter is applied in JS, so a SQL LIMIT would
                    // cut the candidates rather than the answers.
                    .slice(0, listOptions.limit ?? Number.POSITIVE_INFINITY)
                    .map((row): SessionSummary => ({
                        sessionId: row["sid"] as string,
                        title: typeof row["title"] === "string" ? row["title"] : undefined,
                        lastTs: Number(row["last_ts"]),
                        promptCount: Number(row["prompts"]),
                    }))
            );
        },
        transcriptPathOf: (sessionId) => join(projectsDir, `${sessionId}.jsonl`),
        close: () => opened?.close(),
    };
};
