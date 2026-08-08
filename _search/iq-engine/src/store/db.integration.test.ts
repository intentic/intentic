import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compactIndex, openIndex, type Row } from "./db.js";

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
        expect(pragma(db.get("PRAGMA page_count"), "page_count")).toBeLessThan(pagesBefore);
        expect(pragma(db.get("PRAGMA freelist_count"), "freelist_count")).toBeLessThan(freeBefore);
    } finally {
        db.close();
    }
});
