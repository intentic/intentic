// The narrow seam a node:sqlite store is written against, so swapping the driver touches this file and no other.
// node:sqlite is experimental, which is the whole reason a store never holds a DatabaseSync directly.
import type { DatabaseSync } from "node:sqlite";

export type SqliteValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqliteValue>;

export interface SqliteDb {
    all(sql: string, ...params: SqliteValue[]): Row[];
    get(sql: string, ...params: SqliteValue[]): Row | undefined;
    run(sql: string, ...params: SqliteValue[]): void;
    transaction(fn: () => void): void;
    close(): void;
}

/**
 * The seam over a driver handle. `transaction` is an explicit BEGIN/COMMIT/ROLLBACK because node:sqlite has no
 * helper of its own, and a throw inside it must roll back rather than leave the connection inside a transaction.
 */
export const wrapDb = (db: DatabaseSync): SqliteDb => ({
    all: (sql, ...params) => db.prepare(sql).all(...params) as Row[],
    get: (sql, ...params) => db.prepare(sql).get(...params) as Row | undefined,
    run: (sql, ...params) => {
        db.prepare(sql).run(...params);
    },
    transaction: (fn) => {
        db.exec("BEGIN");
        try {
            fn();
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    },
    close: () => db.close(),
});

/**
 * Stamps the version into a fresh database's `meta` table, and refuses one written by a different version.
 * Never a migration: these stores are caches, so the caller answers a mismatch by deleting and reopening.
 */
export const guardSchemaVersion = (db: SqliteDb, version: string, label: string): void => {
    const found = db.get("SELECT value FROM meta WHERE key = 'schema_version'")?.["value"];
    if (found === undefined) {
        db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", version);
        return;
    }
    if (found !== version) {
        db.close();
        throw new Error(`${label} schema ${String(found)} != ${version}`);
    }
};
