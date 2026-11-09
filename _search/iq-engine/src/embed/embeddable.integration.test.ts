import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDb } from "@intentic/base/sqlite";
import { embedPending } from "../engines/semantic.js";
import { openIndex } from "../store/db.js";
import { replaceFile } from "../store/index-store.js";
import { clearVectors, putVector } from "../store/vectors.js";
import type { Embedder } from "./embedder.js";
import { embeddable, NOT_EMBEDDED } from "./embeddable.js";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-embeddable-"));
    db = openIndex(dir, "write");
});
afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

const unit = (): Float32Array => {
    const vec = new Float32Array(384);
    vec[0] = 1;
    return vec;
};

// Records every text it is asked to embed.
const recording = () => {
    const seen: string[] = [];
    const embedder: Embedder = {
        modelId: "fake",
        embedBatch: (texts) => {
            seen.push(...texts);
            return Promise.resolve(texts.map(unit));
        },
        embedQuery: () => Promise.resolve(unit()),
    };
    return { embedder, seen };
};

const index = (path: string, texts: readonly string[]): void => {
    db.transaction(() =>
        replaceFile(
            db,
            { path, repo: undefined, lang: undefined, mtimeMs: 0, size: 1, hash: path, complexity: 0 },
            [],
            texts.map((text, i) => ({ startLine: i + 1, endLine: i + 1, text, hash: `${path}#${text}` })),
            [],
        ),
    );
};

const embeddedOf = (path: string): number[] =>
    db.all("SELECT c.embedded FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.path = ? ORDER BY c.id", path).map((row) => Number(row["embedded"]));

test.each(["_editor/web/src/app/i18n/locales/de.json", "src/locales/en.json", "pnpm-lock.yaml", "_editor/desktop-app/src-tauri/Cargo.lock", "dist/app.min.js"])(
    "%s gets no vectors",
    (path) => {
        expect(embeddable(path)).toBe(false);
    },
);

test.each(["src/i18n/index.ts", "src/widget.ts", "docs/guide.md", "config/app.json"])("%s is embedded", (path) => {
    expect(embeddable(path)).toBe(true);
});

test("catalog and lockfile chunks are indexed without vectors; source chunks are embedded", async () => {
    index("src/locales/de.json", ['"save": "Speichern"']);
    index("pnpm-lock.yaml", ["lockfileVersion: '9.0'"]);
    index("src/widget.ts", ["export const widget = 1"]);
    expect(embeddedOf("src/locales/de.json")).toEqual([NOT_EMBEDDED]);
    expect(embeddedOf("pnpm-lock.yaml")).toEqual([NOT_EMBEDDED]);
    const { embedder, seen } = recording();
    expect(await embedPending(db, embedder)).toBe(0);
    expect(seen).toEqual(["export const widget = 1"]);
    // Still searchable by keyword: the chunk and its FTS row are there.
    expect(db.get("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Speichern'")?.["n"]).toBe(1);
    // A model swap re-queues what was embedded, not what was left out.
    clearVectors(db);
    expect(embeddedOf("src/locales/de.json")).toEqual([NOT_EMBEDDED]);
    expect(embeddedOf("src/widget.ts")).toEqual([0]);
});

test("a catalog chunk queued before the rule is settled without reaching the model", async () => {
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('src/locales/fr.json', 0, 1, 'f')");
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (1, 1, 1, 'h', '\"save\": \"Enregistrer\"')");
    const refusing: Embedder = {
        modelId: "fake",
        embedBatch: () => Promise.reject(new Error("an excluded chunk reached the model")),
        embedQuery: () => Promise.reject(new Error("unused")),
    };
    expect(await embedPending(db, refusing)).toBe(0);
    expect(embeddedOf("src/locales/fr.json")).toEqual([NOT_EMBEDDED]);
});

test("re-indexing an excluded file drops the vectors it had from before", () => {
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('src/locales/en.json', 0, 1, 'f')");
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (1, 1, 1, 'src/locales/en.json#\"save\": \"Save\"', '\"save\": \"Save\"')");
    putVector(db, 1, 1, unit());
    index("src/locales/en.json", ['"save": "Save"']);
    expect(db.get("SELECT COUNT(*) AS n FROM chunk_vectors")?.["n"]).toBe(0);
    expect(embeddedOf("src/locales/en.json")).toEqual([NOT_EMBEDDED]);
});
