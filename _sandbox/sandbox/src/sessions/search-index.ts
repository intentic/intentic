import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MatchSnippet, Speaker } from "@intentic/sandbox-contract";
import type { SpokenLine } from "./transcript-search.js";

/* WHAT WAS SAID, INDEXED, so a phrase search does not read the conversations to answer.
 *
 * The filter on the fleet board used to BUILD its index on the query path: the first search after a boot read
 * every transcript record and every listed session file, extracted the spoken text, and held it in the heap.
 * Measured on a real sandbox (1418 registry entries, 545 MB of records, 1.5 GB of session files) that was
 * ~13 s of blocking work before the first answer, and the daemon's own slow log had the two search routes at a
 * p50 of 17.6 s and 19.1 s, worst 26.8 s. Every keystroke after it re-scanned 30 572 lines in memory, ~100 ms
 * of event-loop time apiece, on data that cannot change: lines are append-only and were being re-normalized
 * and re-folded per query.
 *
 * So the index is durable and written FORWARD, as turns settle. A search reads it and reads nothing else.
 * Measured on that same corpus with this code: 73 MB on disk, 13-35 ms per query, 2.9 ms to add a settled turn,
 * and 20.4 s to build the whole thing once, detached and paced (see search-backfill.ts). There is no cold path
 * left to shorten, because the first search after a boot does the same work as the thousandth.
 *
 * A PURE CACHE, and treated as one: a schema change bumps SCHEMA_VERSION and the file is deleted and rebuilt
 * from the records, which are the truth. Nothing here is ever the only copy of anything.
 *
 * WHY sqlite's trigram tokenizer and not a hand-rolled scan. A phrase filter is substring matching, not word
 * matching: people type "the fleet board" and half a word ("worktre") on the way to a whole one. FTS5's
 * trigram tokenizer is built for exactly that, it accelerates LIKE rather than MATCH, so an arbitrary typed
 * string needs escaping and no query-language parsing, and there is no class of input that becomes a syntax
 * error in the middle of someone typing.
 *
 * WHY A FOLDED COLUMN rather than relying on LIKE. sqlite's own case-insensitivity is ASCII-only: with the
 * text stored as written, `%ärger%` does not find "Ärger im Büro", which the JS `toLowerCase()` this replaces
 * did find. So the searchable column is folded by JS on the way in and the needle is folded by JS on the way
 * out, and the two meet under one rule that covers the whole of Unicode. The text as written rides along
 * UNINDEXED for the snippet, which is display-only and never matched against.
 */

// Bumped on any change to the tables OR to how lines are extracted or folded. A mismatch deletes the file and
// rebuilds, so this is the one and only "migration": there isn't one.
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

// What a source is: a conversation the fleet board cards, or a runtime session the history list rows. Kept
// apart because the two routes answer about different sets and neither should pay for the other's rows.
export type SearchKind = "conversation" | "session";

// How much of the matched line a card shows. Wide enough to carry the sentence the term sits in, short enough
// that the line never outgrows the card it explains.
const SNIPPET_CHARS = 120;

export interface SearchIndexMetrics {
    readonly conversations: number;
    readonly sessions: number;
    readonly lines: number;
}

export interface SearchIndex {
    /* Replace everything indexed for one source. The backfill's verb, and a rewind's: both are "what this
     * source says is not what I have", and re-stating it whole is cheaper to be sure of than reconciling. */
    readonly put: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => void;
    /* Add a settled turn's lines to a source already indexed, the hot path. Append-only, so nothing is read
     * back: the rows go on the end and the version moves to match the record that now holds them. */
    readonly extend: (key: string, kind: SearchKind, version: string, lines: readonly SpokenLine[]) => void;
    // What each source of this kind was last indexed at, for a backfill to diff against the stores.
    readonly versions: (kind: SearchKind) => Map<string, string>;
    // Drop a source entirely: a purged conversation, a session whose file is gone.
    readonly forget: (key: string) => void;
    /* Which sources said this, and the line that proves it. One row per source, the user's own words preferred
     * and the oldest of them, which is the rule the in-memory scan used and the reason it needed two passes.
     *
     * `needle` arrives as the user typed it; folding is this function's job because the fold has to match the
     * one used at ingest exactly, and that is a property of the index, not of the caller.
     */
    readonly search: (needle: string, kind: SearchKind, caseSensitive: boolean) => Map<string, MatchSnippet>;
    readonly metrics: () => SearchIndexMetrics;
    readonly close: () => void;
}

/* The window a card shows: the matched line centred on the hit. Whitespace was collapsed at ingest, so this is
 * only ever a slice. Centre, then clamp to the ends, a match near either edge keeps its full context on the
 * side that has room instead of padding an ellipsis that shows nothing. */
const windowed = (text: string, at: number, length: number): string => {
    if (text.length <= SNIPPET_CHARS) {
        return text;
    }
    const centred = Math.round(at + length / 2 - SNIPPET_CHARS / 2);
    const start = Math.max(0, Math.min(text.length - SNIPPET_CHARS, centred));
    const end = start + SNIPPET_CHARS;
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

// LIKE's own wildcards, escaped so a typed `%` or `_` is a literal. Without this, searching for "100%" matches
// every line in the workspace, which reads as a broken filter rather than as an unescaped pattern.
const likePattern = (folded: string): string => `%${folded.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;

const isSpeaker = (value: unknown): value is Speaker => value === "user" || value === "agent";

// What a test index is: the same schema and the same SQL, with nothing on disk. Passed instead of a directory
// so a suite exercises the real query rather than a stand-in that can drift from it.
export const IN_MEMORY = ":memory:";

export const openSearchIndex = (dir: string): SearchIndex => {
    const memory = dir === IN_MEMORY;
    if (!memory) {
        mkdirSync(dir, { recursive: true });
    }
    const path = memory ? IN_MEMORY : join(dir, "said.db");
    const connect = (): DatabaseSync => {
        const db = new DatabaseSync(path);
        // WAL so a settling turn's append never blocks a search, and NORMAL because this file is a cache: the
        // cost of losing the last write to a power cut is one turn re-indexed at the next boot. Neither applies
        // to a database that is not a file.
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
    // A schema this build does not recognise is not read and not migrated: the file goes, and the backfill
    // refills it from the records. WAL sidecars go with it, or sqlite reopens onto a journal for a file that
    // no longer exists.
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
    /* One row per source: the oldest USER line that matched, else the oldest AGENT line.
     *
     * The preference is not cosmetic. A query is typed from memory, and what a person remembers is their own
     * phrasing; the agent repeating the term back three turns later is the weaker evidence even though it
     * usually sits earlier in a scan. The in-memory version paid two full passes to get this; here it is a
     * partition ordered by speaker then rowid, which the engine does over the matched rows alone.
     *
     * `instr(text, ?)` is the CASE-SENSITIVE confirmation, applied inside the query so the Aa switch narrows
     * rows rather than filtering them afterwards. The LIKE on `fold` is what uses the trigram index and is
     * case-insensitive by construction, so it is a superset in that mode; instr on the text as written cuts it
     * back to exactly what the switch asked for. When the switch is off, `?` is passed empty and instr is
     * trivially true (`instr(x, '')` is 1), so one prepared statement serves both modes.
     */
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
                // Where the hit is, for the window. Recomputed here rather than carried out of sqlite: instr
                // answers in bytes and the offsets a slice needs are UTF-16 code units.
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
