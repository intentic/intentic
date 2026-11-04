import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSearchIndex } from "./search-index.js";
import { FORGET_SQL, SEARCH_SQL } from "./search-store.js";

// An `INDEX 0:` plan with no `L` means fts5 was never offered the LIKE and scans every line said.
test("the search hands its LIKE to the trigram index instead of scanning every line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "said-plan-"));
    try {
        const index = openSearchIndex(dir);
        await index.put("c1", "conversation", "1", [{ text: "fix the login redirect", speaker: "user" }]);
        await index.close();
        const db = new DatabaseSync(join(dir, "said.db"));
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${SEARCH_SQL}`).all("conversation", "%login%", "", "", 1) as { detail: string }[]).map(
            (row) => row.detail,
        );
        db.close();
        expect(plan.some((detail) => /VIRTUAL TABLE INDEX \d+:\S*L\d/u.test(detail))).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// fts5 indexes no UNINDEXED column, so a forget by key scanned every line said; through said_rows it is a primary key
// search, then one rowid lookup (`INDEX 0:=`) per line, never the bare `INDEX 0:` of a full scan.
test("a forget finds a source's lines by key instead of scanning every line said", async () => {
    const dir = mkdtempSync(join(tmpdir(), "said-forget-plan-"));
    try {
        const index = openSearchIndex(dir);
        await index.put("c1", "conversation", "1", [{ text: "fix the login redirect", speaker: "user" }]);
        await index.put("c2", "conversation", "1", [{ text: "tidy the changelog", speaker: "user" }]);
        await index.close();
        const db = new DatabaseSync(join(dir, "said.db"));
        // SAFETY: EXPLAIN QUERY PLAN rows always carry a text `detail`.
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${FORGET_SQL}`).all("c1") as { detail: string }[]).map((row) => row.detail);
        // SAFETY: the SELECT names exactly these two columns, a text key and an integer count.
        const owned = (db.prepare("SELECT key, count(*) AS n FROM said_rows GROUP BY key ORDER BY key").all() as { key: string; n: number }[]).map(
            (row) => [row.key, row.n],
        );
        db.close();
        expect(plan.some((detail) => /SEARCH said_rows USING PRIMARY KEY \(key=\?\)/u.test(detail))).toBe(true);
        expect(plan.some((detail) => /VIRTUAL TABLE INDEX 0:=/u.test(detail))).toBe(true);
        expect(plan.some((detail) => detail.endsWith('VIRTUAL TABLE INDEX 0:'))).toBe(false);
        expect(owned).toEqual([
            ["c1", 1],
            ["c2", 1],
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
