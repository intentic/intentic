import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Row } from "@intentic/base/sqlite";
import { compactIndex, compactVectors, isIndexBusy, openIndex } from "./db.js";
import { nearestChunks, putVector } from "./vectors.js";

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pragma = (row: Row | undefined, key: string): number => Number(row?.[key] ?? 0);

test("new indexes use incremental auto-vacuum and reclaim a materially fragmented freelist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iq-db-"));
    dirs.push(dir);
    const db = openIndex(dir, "write");
    try {
        expect(pragma(db.get("PRAGMA auto_vacuum"), "auto_vacuum")).toBe(2);
        db.run("CREATE TABLE reclaim_probe (payload BLOB NOT NULL)");
        const payload = new Uint8Array(16 * 1024).fill(7);
        db.transaction(() => {
            for (let i = 0; i < 256; i += 1) {
                db.run("INSERT INTO reclaim_probe (payload) VALUES (?)", payload);
            }
        });
        db.run("DELETE FROM reclaim_probe");

        const pagesBefore = pragma(db.get("PRAGMA page_count"), "page_count");
        const freeBefore = pragma(db.get("PRAGMA freelist_count"), "freelist_count");
        expect(freeBefore / pagesBefore).toBeGreaterThan(0.25);
        expect(compactIndex(db)).toBe(true);
        // Every free page goes, not one: the file shrinks by at least the whole freelist (pointer-map pages may follow).
        expect(pragma(db.get("PRAGMA freelist_count"), "freelist_count")).toBe(0);
        expect(pragma(db.get("PRAGMA page_count"), "page_count")).toBeLessThanOrEqual(pagesBefore - freeBefore);
    } finally {
        db.close();
    }
});

// sqlite-vec never reuses a slot a delete frees, so re-indexing leaves the vector table mostly dead: a rebuild has to
// keep every live vector, answer nearest-neighbour queries exactly as before, and give the slots back.
test("a mostly dead vector table is rebuilt packed, keeping every live vector and its answers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iq-db-"));
    dirs.push(dir);
    const db = openIndex(dir, "write");
    const slots = (): number => Number(db.get("SELECT COALESCE(SUM(size), 0) AS n FROM chunk_vectors_chunks")?.["n"] ?? 0);
    try {
        const total = 20_000;
        db.transaction(() => {
            db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a.ts', 0, 1, 'h')");
            for (let i = 1; i <= total; i += 1) {
                db.run("INSERT INTO chunks (id, file_id, start_line, end_line, hash, text) VALUES (?, 1, ?, ?, ?, 'x')", i, i, i, `c${i}`);
                const vec = new Float32Array(384);
                // Distinct directions, so the nearest ten have no ties a rebuild could reorder.
                vec.forEach((_, d) => (vec[d] = Math.sin(i * 0.37 + d * 1.13)));
                putVector(db, i, 1, vec);
            }
        });
        expect(compactVectors(db)).toBe(false);
        // Three quarters of the chunks go, as a re-index would delete them; their vectors go with them by trigger.
        db.run("DELETE FROM chunks WHERE id % 4 != 0");
        const query = new Float32Array(384);
        query.forEach((_, d) => (query[d] = Math.cos(d * 0.71)));
        const before = nearestChunks(db, query, 10, undefined);
        const slotsBefore = slots();

        expect(compactIndex(db)).toBe(true);

        expect(slots()).toBeLessThan(slotsBefore / 2);
        expect(Number(db.get("SELECT COUNT(*) AS n FROM chunk_vectors_rowids")?.["n"])).toBe(total / 4);
        expect(nearestChunks(db, query, 10, undefined)).toEqual(before);
        expect(nearestChunks(db, query, 10, [1]).length).toBe(10);
        // Packed now: nothing to do until deletes thin it out again.
        expect(compactVectors(db)).toBe(false);
    } finally {
        db.close();
    }
});

// Opening an index makes the index dir (nothing else would) and NOTHING ELSE. The spool used to be made here
// too, which left an empty `spool/` sitting in every workspace from its first search onwards, and the explorer,
// rightly, offers to sweep folders with nothing in them. writeSpool makes it when it has something to write.
test("opening an index creates the index dir, and no empty spool beside it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "iq-db-"));
    dirs.push(parent);
    const dir = join(parent, "cache", "iq");
    const db = openIndex(dir, "write");
    try {
        expect(existsSync(join(dir, "index.db"))).toBe(true);
        expect(existsSync(join(dir, "spool"))).toBe(false);
    } finally {
        db.close();
    }
});

// A held write lock is told from corruption by SQLite's own result code, provoked here for real: a second connection
// that will not wait meets the first one's open write transaction. A lock read as corruption would delete the index.
test("a write lock another connection holds reads as busy; a broken statement does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iq-db-"));
    dirs.push(dir);
    const db = openIndex(dir, "write");
    const other = new DatabaseSync(join(dir, "index.db"));
    try {
        other.exec("PRAGMA busy_timeout = 0");
        db.run("BEGIN IMMEDIATE");
        const locked = thrownBy(() => other.exec("BEGIN IMMEDIATE"));
        db.run("ROLLBACK");
        expect(isIndexBusy(locked)).toBe(true);
        expect(isIndexBusy(thrownBy(() => other.exec("SELEC 1")))).toBe(false);
        expect(isIndexBusy(new Error("schema 6 != 7"))).toBe(false);
    } finally {
        other.close();
        db.close();
    }
});

const thrownBy = (run: () => void): Error => {
    try {
        run();
    } catch (error) {
        if (error instanceof Error) {
            return error;
        }
    }
    throw new Error("expected an Error thrown");
};
