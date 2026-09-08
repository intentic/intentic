import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import type { SpokenLine } from "./transcript-search.js";

// What was said, indexed durably and written forward as turns settle, so a search reads only this, never the
// transcripts. A pure cache: a schema bump deletes and rebuilds it from the records. Trigram tokenizer for substring
// matching; a JS-folded column covers full Unicode where sqlite's own folding is ASCII-only, raw text unindexed for the
// snippet.

// Bump on any change to the tables or how lines are extracted/folded; a mismatch deletes the file and rebuilds.
const SCHEMA_VERSION = "1";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
/* One row per indexed source, and the VERSION it was indexed at. For a conversation that is its record's byte
 * size, for a session the size and mtime of its file: both move on any change, which is what lets a boot ask
 * "is this still current" without reading the thing itself. The line count is what the metrics series reports. */
CREATE TABLE IF NOT EXISTS source (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    lines INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS source_kind ON source(kind);
/* The spoken lines. The folded column is the only tokenized one, everything else is carried for the answer:
 * - key/kind: which conversation or session said it
 * - speaker: which side, so a card can say whose words it is showing
 * - text: as written, whitespace already collapsed, for the snippet
 * ROWID ORDER IS TRANSCRIPT ORDER, because insertion is append-only per source. That is what lets the query
 * below pick the OLDEST matching line without storing a position. */
CREATE VIRTUAL TABLE IF NOT EXISTS said USING fts5(
    key UNINDEXED,
    kind UNINDEXED,
    speaker UNINDEXED,
    text UNINDEXED,
    fold,
    tokenize='trigram'
);
`;

// A conversation (fleet board) or a runtime session (history list); kept apart so neither route pays for the other's
// rows.
export type SearchKind = "conversation" | "session";

// Snippet width: wide enough for the sentence around a hit, short enough to fit the card.
const SNIPPET_CHARS = 120;

export interface SearchIndexMetrics {
    readonly conversations: number;
    readonly sessions: number;
    readonly lines: number;
}

export interface SearchIndex {
    // Replaces everything indexed for one source; the backfill's and a rewind's verb, cheaper than reconciling.
    readonly put: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => void;
    // Appends a settled turn's lines, the hot path; append-only, so nothing is read back before writing.
    readonly extend: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => void;
    // What each source of this kind was last indexed at, for a backfill to diff against the stores.
    readonly versions: (kind: SearchKind) => Map<string, string>;
    // Drop a source entirely: a purged conversation, a session whose file is gone.
    readonly forget: (key: string) => void;
    // Oldest user line wins, else oldest agent's, one row per source; folds `needle` to match the ingest fold.
    readonly search: (needle: string, kind: SearchKind, caseSensitive: boolean) => Map<string, MatchSnippet>;
    readonly metrics: () => SearchIndexMetrics;
    readonly close: () => void;
}

// The card's window centered on the hit, then clamped to the text's ends, so a match near an edge keeps full context
// instead of a padded, empty ellipsis.
const windowed = (text: string, at: number, length: number): string => {
    if (text.length <= SNIPPET_CHARS) {
        return text;
    }
    const centred = Math.round(at + length / 2 - SNIPPET_CHARS / 2);
    const start = Math.max(0, Math.min(text.length - SNIPPET_CHARS, centred));
    const end = start + SNIPPET_CHARS;
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

// Escapes LIKE's own wildcards (%, _) so a typed one is literal; unescaped, "100%" would match every line.
const likePattern = (folded: string): string => `%${folded.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;

const isSpeaker = (value: unknown): value is Speaker => value === "user" || value === "agent";

// An in-memory index: same schema and SQL as a real one, so tests exercise the real query, not a stand-in.
export const IN_MEMORY = ":memory:";

export const openSearchIndex = (dir: string): SearchIndex => {
    const memory = dir === IN_MEMORY;
    if (!memory) {
        mkdirSync(dir, { recursive: true });
    }
    const path = memory ? IN_MEMORY : join(dir, "said.db");
    const connect = (): DatabaseSync => {
        const db = new DatabaseSync(path);
        // WAL so an append never blocks a search; NORMAL since a lost last write just re-indexes one turn.
        if (!memory) {
            db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        }
        return db;
    };
    let db = connect();
    const stamped = (): string | undefined => {
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | undefined;
            return row?.value;
        } catch {
            return undefined;
        }
    };
    // An unrecognised schema is not migrated: file and WAL sidecars are deleted, then the backfill refills it.
    if (!memory && stamped() !== SCHEMA_VERSION) {
        db.close();
        for (const suffix of ["", "-wal", "-shm"]) {
            rmSync(`${path}${suffix}`, { force: true });
        }
        db = connect();
    }
    db.exec(DDL);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);

    const insertLine = db.prepare("INSERT INTO said(key, kind, speaker, text, fold) VALUES(?, ?, ?, ?, ?)");
    const deleteLines = db.prepare("DELETE FROM said WHERE key = ?");
    const deleteSource = db.prepare("DELETE FROM source WHERE key = ?");
    const upsertSource = db.prepare(`
        INSERT INTO source(key, kind, version, lines) VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, version = excluded.version, lines = excluded.lines
    `);
    const bumpSource = db.prepare(`
        INSERT INTO source(key, kind, version, lines) VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, version = excluded.version, lines = source.lines + excluded.lines
    `);
    const listVersions = db.prepare("SELECT key, version FROM source WHERE kind = ?");
    const countSources = db.prepare("SELECT kind, count(*) AS sources, coalesce(sum(lines), 0) AS lines FROM source GROUP BY kind");
    // Oldest user line per source, else oldest agent's, via a partition ordered by speaker then rowid. `instr(text, ?)`
    // case-confirms inside the query; empty when insensitive, since `instr(x, '')` is always true.
    const query = db.prepare(`
        SELECT key, speaker, text FROM (
            SELECT key, speaker, text,
                row_number() OVER (PARTITION BY key ORDER BY CASE speaker WHEN 'user' THEN 0 ELSE 1 END, rowid) AS rn
            FROM said
            WHERE kind = ? AND fold LIKE ? ESCAPE '\\' AND instr(text, ?) > 0
        ) WHERE rn = 1
    `);

    const write = (run: () => void): void => {
        db.exec("BEGIN");
        try {
            run();
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    };

    const add = (key: string, kind: SearchKind, lines: readonly SpokenLine[]): void => {
        for (const line of lines) {
            insertLine.run(key, kind, line.speaker, line.text, line.text.toLowerCase());
        }
    };

    return {
        put: (key, kind, version, lines) =>
            write(() => {
                deleteLines.run(key);
                add(key, kind, lines);
                upsertSource.run(key, kind, version, lines.length);
            }),
        extend: (key, kind, version, lines) =>
            write(() => {
                add(key, kind, lines);
                bumpSource.run(key, kind, version, lines.length);
            }),
        versions: (kind) => {
            const rows = listVersions.all(kind) as { key: string; version: string }[];
            return new Map(rows.map((row) => [row.key, row.version]));
        },
        forget: (key) =>
            write(() => {
                deleteLines.run(key);
                deleteSource.run(key);
            }),
        search: (needle, kind, caseSensitive) => {
            const folded = needle.toLowerCase();
            const rows = query.all(kind, likePattern(folded), caseSensitive ? needle : "") as {
                key: string;
                speaker: string;
                text: string;
            }[];
            const found = new Map<string, MatchSnippet>();
            for (const row of rows) {
                if (!isSpeaker(row.speaker)) {
                    continue;
                }
                // Recomputed here, not from sqlite's instr, since that answers in bytes and a slice needs UTF-16 code
                // units.
                const at = (caseSensitive ? row.text : row.text.toLowerCase()).indexOf(caseSensitive ? needle : folded);
                found.set(row.key, { text: windowed(row.text, at === -1 ? 0 : at, needle.length), speaker: row.speaker });
            }
            return found;
        },
        metrics: () => {
            const rows = countSources.all() as { kind: string; sources: number; lines: number }[];
            const of = (kind: SearchKind): { sources: number; lines: number } => rows.find((row) => row.kind === kind) ?? { sources: 0, lines: 0 };
            return {
                conversations: of("conversation").sources,
                sessions: of("session").sources,
                lines: rows.reduce((total, row) => total + row.lines, 0),
            };
        },
        close: () => db.close(),
    };
};
