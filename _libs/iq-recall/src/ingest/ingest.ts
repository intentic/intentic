import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { readLines } from "../transcript/line-reader.js";
import { aiTitleOf, fileTouchesOf, type Line, parseLine, timestampOf, typedPromptOf, typeOf, uuidOf } from "../transcript/lines.js";
import type { RecallDb } from "../store/db.js";

export interface IngestStats {
    transcripts: number;
    sessions: number;
    turns: number;
    files: number;
}

interface NewTurn {
    readonly uuid: string;
    readonly ordinal: number;
    readonly ts: number;
    readonly prompt: string;
    readonly startByte: number;
}

interface Touch {
    modified: boolean;
    lastTs: number;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// Everything one incremental pass over a single transcript produces, applied later in one sync transaction
// (parsing is async, the db seam is not).
interface Delta {
    slug: string | undefined;
    version: string | undefined;
    gitBranch: string | undefined;
    title: string | undefined;
    minTs: number | undefined;
    maxTs: number | undefined;
    byteOffset: number;
    newTurns: NewTurn[];
    // Keyed by turn ordinal — including the still-open turn restored from a previous pass.
    touches: Map<number, Map<string, Touch>>;
}

const parseDelta = async (path: string, fromByte: number, lastOrdinal: number, root: string): Promise<Delta> => {
    const delta: Delta = {
        slug: undefined,
        version: undefined,
        gitBranch: undefined,
        title: undefined,
        minTs: undefined,
        maxTs: undefined,
        byteOffset: fromByte,
        newTurns: [],
        touches: new Map(),
    };
    let ordinal = lastOrdinal;
    let lineStart = fromByte;
    for await (const { json, endByte } of readLines(path, fromByte)) {
        const startByte = lineStart;
        lineStart = endByte;
        delta.byteOffset = endByte;
        const line = parseLine(json);
        if (line === undefined) {
            continue;
        }
        const ts = timestampOf(line);
        if (ts !== undefined) {
            delta.minTs = Math.min(delta.minTs ?? ts, ts);
            delta.maxTs = Math.max(delta.maxTs ?? ts, ts);
        }
        delta.slug ??= asString(line["slug"]);
        delta.version ??= asString(line["version"]);
        delta.gitBranch ??= asString(line["gitBranch"]);
        const title = aiTitleOf(line);
        if (title !== undefined) {
            delta.title = title;
        }
        const prompt = typedPromptOf(line);
        const uuid = uuidOf(line);
        if (prompt !== undefined && uuid !== undefined && ts !== undefined) {
            ordinal += 1;
            delta.newTurns.push({ uuid, ordinal, ts, prompt, startByte });
            continue;
        }
        if (ordinal < 0) {
            continue;
        }
        for (const { path: touched, modified } of fileTouchesOf(line)) {
            const rel = relative(root, touched);
            if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
                continue;
            }
            const byPath = delta.touches.get(ordinal) ?? new Map<string, Touch>();
            delta.touches.set(ordinal, byPath);
            const touch = byPath.get(rel);
            if (touch === undefined) {
                byPath.set(rel, { modified, lastTs: ts ?? delta.maxTs ?? 0 });
            } else {
                touch.modified ||= modified;
                touch.lastTs = Math.max(touch.lastTs, ts ?? 0);
            }
        }
    }
    return delta;
};

const applyDelta = (db: RecallDb, transcriptPath: string, sessionId: string, delta: Delta, stat: { mtimeMs: number; size: number }): void => {
    db.run(
        `INSERT INTO sessions (session_id, slug, title, version, git_branch, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             slug = coalesce(sessions.slug, excluded.slug),
             title = coalesce(excluded.title, sessions.title),
             version = coalesce(sessions.version, excluded.version),
             git_branch = coalesce(sessions.git_branch, excluded.git_branch),
             first_ts = min(sessions.first_ts, excluded.first_ts),
             last_ts = max(sessions.last_ts, excluded.last_ts)`,
        sessionId,
        delta.slug ?? null,
        delta.title ?? null,
        delta.version ?? null,
        delta.gitBranch ?? null,
        // A timestamp-less delta (e.g. only a late ai-title line) must not move the session's time range:
        // min() ignores now, max() ignores 0.
        delta.minTs ?? Date.now(),
        delta.maxTs ?? 0,
    );
    const sessionRowId = db.get("SELECT id FROM sessions WHERE session_id = ?", sessionId)?.["id"] as number;
    for (const turn of delta.newTurns) {
        db.run("INSERT INTO turns (session_id, uuid, ordinal, ts, prompt, start_byte) VALUES (?, ?, ?, ?, ?, ?)", sessionRowId, turn.uuid, turn.ordinal, turn.ts, turn.prompt, turn.startByte);
    }
    for (const [ordinal, byPath] of delta.touches) {
        const turnId = db.get("SELECT id FROM turns WHERE session_id = ? AND ordinal = ?", sessionRowId, ordinal)?.["id"] as number | undefined;
        if (turnId === undefined) {
            continue;
        }
        for (const [path, touch] of byPath) {
            db.run(
                `INSERT INTO turn_files (turn_id, path, modified, last_ts) VALUES (?, ?, ?, ?)
                 ON CONFLICT(turn_id, path) DO UPDATE SET
                     modified = max(turn_files.modified, excluded.modified),
                     last_ts = max(turn_files.last_ts, excluded.last_ts)`,
                turnId,
                path,
                touch.modified ? 1 : 0,
                touch.lastTs,
            );
        }
    }
    db.run(
        `INSERT INTO transcripts (path, session_id, byte_offset, mtime_ms, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, mtime_ms = excluded.mtime_ms, size = excluded.size`,
        transcriptPath,
        sessionId,
        delta.byteOffset,
        stat.mtimeMs,
        stat.size,
    );
};

// Incrementally mirror the workspace's transcript dir into the recall index: unchanged files are skipped via
// (mtime, size), grown files are parsed from their stored byte offset, vanished files lose their rows.
export const ingest = async (db: RecallDb, options: { root: string; projectsDir: string }): Promise<IngestStats> => {
    const onDisk = new Map<string, { mtimeMs: number; size: number }>();
    let entries: string[];
    try {
        entries = readdirSync(options.projectsDir);
    } catch {
        entries = [];
    }
    for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) {
            continue;
        }
        const path = join(options.projectsDir, entry);
        const stat = statSync(path);
        if (stat.isFile()) {
            onDisk.set(path, { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size });
        }
    }
    const known = new Map(db.all("SELECT path, session_id, byte_offset, mtime_ms, size FROM transcripts").map((row) => [row["path"] as string, row]));
    for (const [path, row] of known) {
        if (onDisk.has(path)) {
            continue;
        }
        db.transaction(() => {
            db.run("DELETE FROM sessions WHERE session_id = ?", row["session_id"] as string);
            db.run("DELETE FROM transcripts WHERE path = ?", path);
        });
    }
    for (const [path, stat] of onDisk) {
        const row = known.get(path);
        if (row !== undefined && Number(row["mtime_ms"]) === stat.mtimeMs && Number(row["size"]) === stat.size) {
            continue;
        }
        const sessionId = basename(path, ".jsonl");
        let fromByte = row === undefined ? 0 : Number(row["byte_offset"]);
        if (fromByte > stat.size) {
            // Shrunk transcripts should not exist (append-only) — treat as a rewrite and reparse fully.
            db.transaction(() => {
                db.run("DELETE FROM sessions WHERE session_id = ?", sessionId);
                db.run("DELETE FROM transcripts WHERE path = ?", path);
            });
            fromByte = 0;
        }
        const lastOrdinal =
            fromByte === 0
                ? -1
                : Number(
                      db.get("SELECT max(t.ordinal) AS n FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = ?", sessionId)?.["n"] ?? -1,
                  );
        const delta = await parseDelta(path, fromByte, lastOrdinal, options.root);
        db.transaction(() => {
            applyDelta(db, path, sessionId, delta, stat);
        });
    }
    const count = (sql: string): number => Number(db.get(sql)?.["n"] ?? 0);
    return {
        transcripts: count("SELECT COUNT(*) AS n FROM transcripts"),
        sessions: count("SELECT COUNT(*) AS n FROM sessions"),
        turns: count("SELECT COUNT(*) AS n FROM turns"),
        files: count("SELECT COUNT(DISTINCT path) AS n FROM turn_files"),
    };
};
