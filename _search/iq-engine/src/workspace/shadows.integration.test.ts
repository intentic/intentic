import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SqliteDb } from "@intentic/base/sqlite";
import { DERIVED_SHADOWS_DIR } from "@intentic/constants";
import { bm25Search } from "../engines/bm25.js";
import { parseEntry } from "../indexer/parse-entry.js";
import { revalidate } from "../indexer/indexer.js";
import { openIndex } from "../store/db.js";
import { listFiles } from "../store/index-store.js";
import { contextOf } from "../verbs/context.js";
import { indexLookup } from "../verify/lookup.js";
import { isIqDenied } from "./floor.js";
import { classOf, sweep } from "./scan.js";

/* Documents are searched by their shadows' text, under their own paths, page-marked like `rg -n` prints them. */

let root: string;
let indexDir: string;
let db: SqliteDb;

const SHADOW = (body: string): string => `---\nsource: docs/terms.pdf\nsha256: abc\nderiver: pdf v2\nsource_size: 9\nsource_mtime: 1.000000000\n---\n${body}\n`;
const BODY = "## Page 1\n\nIntroduction to the terms.\n\n## Page 2\n\nEach wniosek must be filed in writing.";

const put = async (relPath: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(dirname(join(root, relPath)), { recursive: true });
    await writeFile(join(root, relPath), content);
};

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-shadows-"));
    indexDir = await mkdtemp(join(tmpdir(), "iq-shadows-index-"));
    db = openIndex(indexDir, "write");
    await put("docs/terms.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 0]));
    await put("docs/unread.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 9]));
    await put("src/app.ts", "export const app = 1;\n");
    await put(`${DERIVED_SHADOWS_DIR}/docs/terms.pdf.md`, SHADOW(BODY));
    // A shadow of something that is not a document (an html page someone opened) never stands in for its source.
    await put("page.html", "<p>source html</p>\n");
    await put(`${DERIVED_SHADOWS_DIR}/page.html.md`, "---\nsha256: x\n---\nrendered html\n");
});
afterAll(async () => {
    db.close();
    await rm(indexDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
});

test("the sweep points a shadowed document at its shadow, and only documents", async () => {
    const { entries } = await sweep(root, false);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("docs/terms.pdf")?.text).toBe(join(root, DERIVED_SHADOWS_DIR, "docs/terms.pdf.md"));
    expect(byPath.get("docs/unread.pdf")?.text).toBeUndefined();
    expect(byPath.get("page.html")?.text).toBeUndefined();
    // The floor still hides the shadow tree itself: no entry is ever a path under .intentic/local/cache.
    expect(entries.some((entry) => isIqDenied(entry.path))).toBe(false);
});

test("indexed under the document's path, chunked by page, each line carrying its page", async () => {
    await revalidate(db, (await sweep(root, false)).entries, parseEntry);
    const hits = bm25Search(db, "wniosek filed writing", new Set(["docs/terms.pdf", "src/app.ts", "docs/unread.pdf"]));
    expect(hits[0]).toMatchObject({ path: "docs/terms.pdf", text: "[p. 2] ## Page 2" });
    const chunks = db.all("SELECT c.text, c.start_line FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = 'docs/terms.pdf' ORDER BY c.start_line");
    expect(chunks.map((row) => String(row["text"]).split("\n")[0])).toEqual(["docs/terms.pdf § p. 1", "docs/terms.pdf § p. 2"]);
    // Line 7 of the text is the one `rg -n` numbers 7 for the same document.
    expect(chunks[1]?.["start_line"]).toBe(5);
    expect(listFiles(db).get("docs/unread.pdf")?.hash).toBe("-");
});

test("a changed shadow is re-indexed; a removed one leaves the document's bytes, which index as nothing", async () => {
    await put(`${DERIVED_SHADOWS_DIR}/docs/terms.pdf.md`, SHADOW(`${BODY}\n\n## Page 3\n\nAppeals go to the board.`));
    const later = new Date(Date.now() + 10_000);
    await utimes(join(root, DERIVED_SHADOWS_DIR, "docs/terms.pdf.md"), later, later);
    const changed = await revalidate(db, (await sweep(root, false)).entries, parseEntry);
    expect(changed.changed).toBe(1);
    expect(bm25Search(db, "appeals board", new Set(["docs/terms.pdf"]))[0]?.text).toBe("[p. 3] ## Page 3");
    await rm(join(root, DERIVED_SHADOWS_DIR, "docs/terms.pdf.md"));
    await revalidate(db, (await sweep(root, false)).entries, parseEntry);
    expect(bm25Search(db, "appeals board", new Set(["docs/terms.pdf"]))).toEqual([]);
    await put(`${DERIVED_SHADOWS_DIR}/docs/terms.pdf.md`, SHADOW(BODY));
});

test("context and verify read a document's lines from its shadow", async () => {
    await revalidate(db, (await sweep(root, false)).entries, parseEntry);
    const { groups } = await contextOf(db, root, "docs/terms.pdf:7", 0);
    expect(groups[0]?.hits.find((hit) => hit.line === 7)?.text).toBe("[p. 2] Each wniosek must be filed in writing.");
    const lookup = indexLookup(db, root, (await sweep(root, false)).entries);
    expect(lookup.lineCount("docs/terms.pdf")).toBe(7);
    expect(lookup.occurrences("docs/terms.pdf", "wniosek")).toEqual([7]);
});

test("documents rank with the docs prior, wherever they sit", () => {
    expect(classOf("terms.pdf")).toBe("docs");
    expect(classOf("finance/budget.XLSX")).toBe("docs");
    expect(classOf("src/app.ts")).toBe("src");
});
