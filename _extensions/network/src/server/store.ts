import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { AddSourceSchema, CurateSchema, ItemSchema, SearchSchema, SourceSchema, type Item, type Search, type Source } from "../wire.js";
import { BridgeItemSchema, type BridgeItem } from "./records.js";

const MIGRATIONS = [
    `CREATE TABLE sources (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL,
        schemaType TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL,
        lastPollAt INTEGER, nextPollAt INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        lastError TEXT, etag TEXT, lastModified TEXT, UNIQUE(kind, address, schemaType)
    );
    CREATE TABLE items (
        id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        nativeId TEXT NOT NULL, nativeUrl TEXT, record TEXT NOT NULL, type TEXT NOT NULL, searchText TEXT NOT NULL,
        fetchedAt INTEGER NOT NULL, publishedAt INTEGER, verification TEXT NOT NULL
            CHECK (verification IN ('unsigned', 'signature-valid', 'signature-invalid')),
        verifiedBy TEXT, signingKey TEXT, score REAL, summary TEXT, labels TEXT NOT NULL DEFAULT '[]', curatedAt INTEGER
    );
    CREATE INDEX items_source ON items(sourceId);
    CREATE INDEX items_time ON items(publishedAt, fetchedAt);
    CREATE INDEX items_score ON items(score);`,
    // 2026-11-28: this sandbox's own log (log-store.ts): its signed entries, its checkpoints, and what waits for a yes.
    `CREATE TABLE log_entries (
        seq INTEGER PRIMARY KEY, leaf TEXT NOT NULL, signed TEXT, type TEXT, headline TEXT,
        publishedAt TEXT NOT NULL, tombstoneOf INTEGER, cosigned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE log_checkpoints (size INTEGER PRIMARY KEY, checkpoint TEXT NOT NULL, signedAt INTEGER NOT NULL);
    CREATE TABLE log_drafts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('publish', 'withdraw')), digest TEXT NOT NULL,
        record TEXT, target INTEGER, cosign TEXT NOT NULL CHECK (cosign IN ('offered', 'required')),
        createdAt INTEGER NOT NULL, doneSeq INTEGER
    );`,
    // 2026-11-28: other sandboxes this one follows (peers/peer-store.ts): the identity pinned for each, what was verified of
    // its log, a copy of every leaf to catch a rewritten history, and, as a witness, the last checkpoint cosigned per log.
    `CREATE TABLE peers (
        sourceId TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, address TEXT NOT NULL, host TEXT NOT NULL,
        document TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('ok', 'held', 'equivocation')), problem TEXT,
        checkpoint TEXT, size INTEGER NOT NULL DEFAULT 0, cosigned INTEGER NOT NULL DEFAULT 0, witnessed TEXT NOT NULL DEFAULT '[]',
        catalog TEXT, evidence TEXT, syncedAt INTEGER
    );
    CREATE TABLE peer_entries (
        sourceId TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, seq INTEGER NOT NULL, leaf TEXT NOT NULL, signed TEXT,
        PRIMARY KEY (sourceId, seq)
    );
    CREATE TABLE witness_state (origin TEXT PRIMARY KEY, size INTEGER NOT NULL, root TEXT NOT NULL, checkpoint TEXT NOT NULL, at INTEGER NOT NULL);`,
] as const;

type Row = Record<string, SQLOutputValue>;
const sourceRow = (raw: Row): Source => {
    const row = z.looseObject({ enabled: z.number() }).parse(raw);
    return SourceSchema.parse({ ...row, enabled: row.enabled === 1 });
};
const itemRow = (raw: Row): Item => {
    const row = z.looseObject({ record: z.string(), labels: z.string(), nativeUrl: z.string().nullable(), verifiedBy: z.string().nullable(), signingKey: z.string().nullable() }).parse(raw);
    return ItemSchema.parse({ ...row, record: JSON.parse(row.record), labels: JSON.parse(row.labels), nativeUrl: row.nativeUrl ?? undefined, verifiedBy: row.verifiedBy ?? undefined, signingKey: row.signingKey ?? undefined });
};
const itemId = (sourceId: string, nativeId: string): string => createHash("sha256").update(JSON.stringify([sourceId, nativeId])).digest("hex");

export class NetworkStore {
    readonly db: DatabaseSync;
    readonly fullText: boolean;
    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        const version = z.object({ user_version: z.number() }).parse(this.db.prepare("PRAGMA user_version").get()).user_version;
        if (version > MIGRATIONS.length) {
            this.db.close();
            throw new Error("Network database is newer than this extension");
        }
        for (let i = version; i < MIGRATIONS.length; i++) {
            this.transaction(() => {
                this.db.exec(MIGRATIONS[i]!);
                this.db.exec(`PRAGMA user_version = ${i + 1}`);
            });
        }
        // Whether this SQLite was built with FTS5, asked of SQLite itself; without it, search falls back to LIKE.
        this.fullText = z.object({ fts5: z.number() }).parse(this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5").get()).fts5 === 1;
        if (this.fullText) {
            this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(searchText, content='items', content_rowid='rowid');
                CREATE TRIGGER IF NOT EXISTS items_insert AFTER INSERT ON items BEGIN
                    INSERT INTO item_search(rowid, searchText) VALUES (new.rowid, new.searchText); END;
                CREATE TRIGGER IF NOT EXISTS items_delete AFTER DELETE ON items BEGIN
                    INSERT INTO item_search(item_search, rowid, searchText) VALUES ('delete', old.rowid, old.searchText); END;
                CREATE TRIGGER IF NOT EXISTS items_update AFTER UPDATE ON items BEGIN
                    INSERT INTO item_search(item_search, rowid, searchText) VALUES ('delete', old.rowid, old.searchText);
                    INSERT INTO item_search(rowid, searchText) VALUES (new.rowid, new.searchText); END;`);
            // Covers a database first opened on an SQLite build without FTS5.
            this.db.exec("INSERT INTO item_search(item_search) VALUES ('rebuild')");
        }
    }
    transaction<T>(run: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try { const result = run(); this.db.exec("COMMIT"); return result; }
        catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    close(): void { this.db.close(); }
    sources(): Source[] { return this.db.prepare("SELECT * FROM sources ORDER BY createdAt, id").all().map(sourceRow); }
    source(id: string): Source | undefined { const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id); return row ? sourceRow(row) : undefined; }
    add(input: z.input<typeof AddSourceSchema>, now: number): Source {
        const source = AddSourceSchema.parse(input);
        if (this.sources().length >= 200) {throw new Error("Network supports up to 200 sources");}
        const id = randomUUID();
        this.db.prepare("INSERT INTO sources(id, kind, address, label, schemaType, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(id, source.kind, source.address, source.label || source.address, source.schemaType, now);
        return this.source(id)!;
    }
    remove(id: string): void { this.db.prepare("DELETE FROM sources WHERE id = ?").run(id); }
    // An item its source withdrew (a peer's tombstone): it leaves this store too.
    forget(sourceId: string, nativeIds: readonly string[]): void {
        for (const nativeId of nativeIds) {this.db.prepare("DELETE FROM items WHERE id = ?").run(itemId(sourceId, nativeId));}
    }
    enable(id: string, enabled: boolean): void { this.db.prepare("UPDATE sources SET enabled = ? WHERE id = ?").run(Number(enabled), id); }
    polled(id: string, state: Pick<Source, "lastPollAt" | "nextPollAt" | "failures" | "lastError" | "etag" | "lastModified">): void {
        this.db.prepare("UPDATE sources SET lastPollAt=?, nextPollAt=?, failures=?, lastError=?, etag=?, lastModified=? WHERE id=?").run(state.lastPollAt, state.nextPollAt, state.failures, state.lastError, state.etag, state.lastModified, id);
    }
    ingest(sourceId: string, incoming: readonly BridgeItem[], now: number): number {
        let changed = 0;
        this.transaction(() => {
            for (const raw of incoming) {
                const item = BridgeItemSchema.parse(raw);
                const id = itemId(sourceId, item.nativeId);
                const record = JSON.stringify(item.record);
                const previous = this.item(id);
                if (previous && JSON.stringify(previous.record) === record && previous.verification === item.verification && previous.signingKey === item.signingKey) {continue;}
                const text = [item.record.headline, item.record.text, item.record.articleBody, item.record.author?.name, ...item.record.keywords].filter(Boolean).join("\n");
                this.db.prepare(`INSERT INTO items(id, sourceId, nativeId, nativeUrl, record, type, searchText, fetchedAt, publishedAt, verification, verifiedBy, signingKey)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET nativeUrl=excluded.nativeUrl, record=excluded.record, type=excluded.type,
                    searchText=excluded.searchText, publishedAt=excluded.publishedAt, verification=excluded.verification,
                    verifiedBy=excluded.verifiedBy, signingKey=excluded.signingKey, score=NULL, summary=NULL, labels='[]', curatedAt=NULL`).run(
                    id, sourceId, item.nativeId, item.nativeUrl ?? null, record, item.record["@type"], text, now,
                    item.record.datePublished ? Date.parse(item.record.datePublished) : null, item.verification, item.verifiedBy ?? null, item.signingKey ?? null,
                );
                changed++;
            }
        });
        return changed;
    }
    item(id: string): Item | undefined { const row = this.db.prepare("SELECT * FROM items WHERE id=?").get(id); return row ? itemRow(row) : undefined; }
    search(raw: Partial<Search> = {}, curated = false): Item[] {
        const input = SearchSchema.parse(raw);
        const where: string[] = [];
        const args: SQLInputValue[] = [];
        if (input.query?.trim()) {
            if (this.fullText) {
                where.push("rowid IN (SELECT rowid FROM item_search WHERE item_search MATCH ?)");
                args.push(input.query.trim().split(/\s+/u).map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND "));
            } else {
                where.push("searchText LIKE ? ESCAPE '\\'");
                args.push(`%${input.query.replaceAll(/[%_\\]/gu, "\\$&")}%`);
            }
        }
        if (input.type) { where.push("type=?"); args.push(input.type); }
        if (input.source) { where.push("sourceId=?"); args.push(input.source); }
        if (input.since) { where.push("COALESCE(publishedAt, fetchedAt)>=?"); args.push(Date.parse(input.since)); }
        if (input.uncurated) {where.push("curatedAt IS NULL");}
        args.push(input.limit);
        return this.db.prepare(`SELECT * FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY ${curated ? "COALESCE(score, 0) DESC," : ""} COALESCE(publishedAt, fetchedAt) DESC, id LIMIT ?`).all(...args).map(itemRow);
    }
    uncuratedCount(): number {
        return z.object({ count: z.number() }).parse(this.db.prepare("SELECT COUNT(*) AS count FROM items WHERE curatedAt IS NULL").get()).count;
    }
    curate(entries: readonly z.infer<typeof CurateSchema>[], now: number): void {
        const parsed = z.array(CurateSchema).min(1).max(100).parse(entries);
        this.transaction(() => {
            for (const entry of parsed) {
                if (!this.item(entry.id)) {throw new Error(`Unknown item: ${entry.id}`);}
                this.db.prepare("UPDATE items SET score=?, summary=?, labels=?, curatedAt=? WHERE id=?").run(entry.score, entry.summary, JSON.stringify(entry.labels), now, entry.id);
            }
        });
    }
    prune(now: number, days: number, maxItems: number): void {
        this.transaction(() => {
            this.db.prepare("DELETE FROM items WHERE MIN(COALESCE(publishedAt, fetchedAt), fetchedAt) < ?").run(now - days * 86400000);
            this.db.prepare("DELETE FROM items WHERE id NOT IN (SELECT id FROM items ORDER BY COALESCE(publishedAt, fetchedAt) DESC, id LIMIT ?)").run(maxItems);
        });
    }
}
