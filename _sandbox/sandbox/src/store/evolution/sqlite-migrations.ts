import { open } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../sqlite.js";

// Schema evolution for the daemon's SQLite databases, versioned by the one number SQLite keeps for exactly this
// (`PRAGMA user_version`, stamped inside the same transaction as the step it counts, so a crash leaves a database at a
// version it fully has). Version 1 is the baseline schema, created with IF NOT EXISTS so a database from before any
// version was stamped simply takes it; every later step is appended, never edited, and adds rather than removes (a new
// nullable column, a new table) so a rolled-back build still reads and writes what a newer one left.

export interface SqliteStep {
    // One line for the plan and the ledger: "adds conversation.pinned".
    readonly describe: string;
    readonly up: (db: DatabaseSync) => void;
}

export interface SqliteMigration {
    readonly from: number;
    readonly to: number;
    // A newer build's database: left as it is, since its steps only added what this build ignores.
    readonly newer: boolean;
}

export const schemaVersionOf = (db: DatabaseSync): number => {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : 0;
};

export const targetVersion = (steps: readonly SqliteStep[]): number => 1 + steps.length;

export const migrateSqlite = (db: DatabaseSync, baseline: string, steps: readonly SqliteStep[]): SqliteMigration => {
    const from = schemaVersionOf(db);
    const to = targetVersion(steps);
    if (from > to) {
        return { from, to, newer: true };
    }
    if (from === 0) {
        transaction(db, () => {
            db.exec(baseline);
            db.exec("PRAGMA user_version = 1");
        });
    }
    for (let version = Math.max(from, 1); version < to; version++) {
        const step = steps[version - 1];
        if (step === undefined) {
            break;
        }
        transaction(db, () => {
            step.up(db);
            db.exec(`PRAGMA user_version = ${version + 1}`);
        });
    }
    return { from, to, newer: false };
};

// The version stamped in a database file's header (byte 60, big-endian), read without SQLite: a read-only mount cannot
// open a WAL database, and the pre-flight only needs the number. Undefined for a missing or truncated file. A stamp still
// sitting in an uncheckpointed WAL reads as the older number, which only makes a plan announce a step that finds
// nothing to do.
export const headerSchemaVersion = async (path: string): Promise<number | undefined> => {
    // Only a missing file reads as no version; a file that exists but cannot be opened fails the step that asked.
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const header = Buffer.alloc(100);
        const { bytesRead } = await handle.read(header, 0, 100, 0);
        return bytesRead < 64 ? undefined : header.readUInt32BE(60);
    } finally {
        await handle.close();
    }
};
