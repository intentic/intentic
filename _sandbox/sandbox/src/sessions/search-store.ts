import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { immediateTransaction, IN_MEMORY, openSqlite } from "@intentic/base/sqlite";
import type { MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import type { SearchIndexMetrics, SearchKind } from "./search-index.js";
import type { SpokenLine } from "./transcript-search.js";

// The phrase index's SQLite connection and its SQL, synchronous by nature, so it runs only inside the index's worker
// thread (search-index-worker.ts). A pure cache: a schema bump deletes and rebuilds it from the records. Trigram
// tokenizer for substring matching; a JS-folded column covers full Unicode where sqlite's own folding is ASCII-only.

// Bump on any change to the tables or how lines are extracted/folded; a mismatch deletes the file and rebuilds.
const SCHEMA_VERSION = "1";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
/* Each indexed source stores the version needed to detect record changes without rereading it. */
CREATE TABLE IF NOT EXISTS source (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    lines INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS source_kind ON source(kind);
/* The spoken lines. The folded column is the only tokenized one, everything else is carried for the answer. */
CREATE VIRTUAL TABLE IF NOT EXISTS said USING fts5(
    key UNINDEXED,
    kind UNINDEXED,
    speaker UNINDEXED,
    text UNINDEXED,
    fold,
    tokenize='trigram'
);
`;

// Snippet width: wide enough for the sentence around a hit, short enough to fit the card.
const SNIPPET_CHARS = 120;

export interface SearchStore {
    // Drops a source and its lines, as one transaction; a put's first step as well as a purge.
    readonly forget: (key: string) => void;
    // Inserts one batch of a source's lines, as one transaction; the source row is stamped separately, once all landed.
    readonly add: (key: string, kind: SearchKind, lines: readonly SpokenLine[]) => void;
    // Records what a fully indexed source was indexed at.
    readonly stamp: (key: string, kind: SearchKind, version: string, lines: number) => void;
    // Appends a settled turn's lines and bumps its source, as one transaction.
    readonly extend: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => void;
    readonly versions: (kind: SearchKind) => Map<string, string>;
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

// Never escaped: sqlite offers fts5 only a two-argument LIKE, so an ESCAPE clause turns the trigram index into a scan.
const likePattern = (folded: string): string => `%${folded}%`;

// A typed `%` or `_` only widens the LIKE; this literal re-check narrows it back, empty (always true) when none is typed.
const literalNeedle = (folded: string): string => (/[%_]/u.test(folded) ? folded : "");

// Oldest user line per source, else oldest agent's, via a partition ordered by speaker then rowid. Binds: kind,
// likePattern, literalNeedle, then the raw needle when case-sensitive or "" when not, since `instr(x, '')` is always 1.
export const SEARCH_SQL = `
    SELECT key, speaker, text FROM (
        SELECT key, speaker, text,
            row_number() OVER (PARTITION BY key ORDER BY CASE speaker WHEN 'user' THEN 0 ELSE 1 END, rowid) AS rn
        FROM said
        WHERE kind = ? AND fold LIKE ? AND instr(fold, ?) > 0 AND instr(text, ?) > 0
    ) WHERE rn = 1
`;

const isSpeaker = (value: unknown): value is Speaker => value === "user" || value === "agent";

// `IN_MEMORY` for a store with the same schema and SQL as a real one, so tests exercise the real query.
export const openSearchStore = (dir: string): SearchStore => {
    const memory = dir === IN_MEMORY;
    const path = memory ? IN_MEMORY : join(dir, "said.db");
    // A lost last write under WAL's NORMAL sync just re-indexes one turn.
    let db: DatabaseSync = openSqlite(path);
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
        db = openSqlite(path);
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
    const query = db.prepare(SEARCH_SQL);

    const insert = (key: string, kind: SearchKind, lines: readonly SpokenLine[]): void => {
        for (const line of lines) {
            insertLine.run(key, kind, line.speaker, line.text, line.text.toLowerCase());
        }
    };

    return {
        forget: (key) =>
            immediateTransaction(db, () => {
                deleteLines.run(key);
                deleteSource.run(key);
            }),
        add: (key, kind, lines) => immediateTransaction(db, () => insert(key, kind, lines)),
        stamp: (key, kind, version, lines) => void upsertSource.run(key, kind, version, lines),
        extend: (key, kind, version, lines) =>
            immediateTransaction(db, () => {
                insert(key, kind, lines);
                bumpSource.run(key, kind, version, lines.length);
            }),
        versions: (kind) => {
            const rows = listVersions.all(kind) as { key: string; version: string }[];
            return new Map(rows.map((row) => [row.key, row.version]));
        },
        search: (needle, kind, caseSensitive) => {
            const folded = needle.toLowerCase();
            const rows = query.all(kind, likePattern(folded), literalNeedle(folded), caseSensitive ? needle : "") as {
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
