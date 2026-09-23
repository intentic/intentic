import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSearchIndex } from "./search-index.js";
import { SEARCH_SQL } from "./search-store.js";

// An `INDEX 0:` plan with no `L` means fts5 was never offered the LIKE and scans every line said.
test("the search hands its LIKE to the trigram index instead of scanning every line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "said-plan-"));
    try {
        const index = openSearchIndex(dir);
        await index.put("c1", "conversation", "1", [{ text: "fix the login redirect", speaker: "user" }]);
        await index.close();
        const db = new DatabaseSync(join(dir, "said.db"));
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${SEARCH_SQL}`).all("conversation", "%login%", "", "") as { detail: string }[]).map(
            (row) => row.detail,
        );
        db.close();
        expect(plan.some((detail) => /VIRTUAL TABLE INDEX \d+:\S*L\d/u.test(detail))).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
