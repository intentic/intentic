import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../embed/embedder.js";
import type { SqliteDb } from "@intentic/base/sqlite";
import { openIndex } from "../store/db.js";
import { copyVector, putVector, vectorsOfFile } from "../store/vectors.js";
import { embedPending, semanticSearch } from "./semantic.js";

let dir: string;
let db: SqliteDb;

const vec = (values: number[]): Float32Array => {
    const f = new Float32Array(384);
    values.forEach((value, i) => (f[i] = value));
    return f;
};

// Deterministic fake: text containing "widget" → e1, else e2.
const fakeEmbedder: Embedder = {
    modelId: "fake",
    embedBatch: (texts) =>
        Promise.resolve(
            texts.map((text) => {
                const f = new Float32Array(384);
                f[text.includes("widget") ? 0 : 1] = 1;
                return f;
            }),
        ),
    embedQuery: () => {
        const f = new Float32Array(384);
        f[0] = 1;
        return Promise.resolve(f);
    },
};

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-sem-"));
    db = openIndex(dir, "write");
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a/widget.ts', 0, 1, 'h1')");
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('b/other.ts', 0, 1, 'h2')");
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (1, 1, 5, 'c1', 'a/widget.ts § widget\\ncreates a widget')");
    putVector(db, 1, 1, vec([1, 0]));
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (2, 1, 5, 'c2', 'b/other.ts § other\\nsomething else')");
    putVector(db, 2, 2, vec([0, 1]));
    // Left unembedded on purpose: embedPending's backlog.
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (2, 6, 9, 'c3', 'b/other.ts § pending widget text')");
});
afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

test("semanticSearch ranks by cosine similarity and respects the allowed set", () => {
    const query = new Float32Array(384);
    query[0] = 1;
    const hits = semanticSearch(db, query, new Set(["a/widget.ts", "b/other.ts"]));
    expect(hits[0]?.path).toBe("a/widget.ts");
    expect(hits[0]?.tags[0]).toEqual({ kind: "sem", score: 1 });
    expect(semanticSearch(db, query, new Set(["b/other.ts"])).every((hit) => hit.path === "b/other.ts")).toBe(true);
});

test("embedPending fills missing embeddings and reports the remainder", async () => {
    expect(await embedPending(db, fakeEmbedder)).toBe(0);
    const query = new Float32Array(384);
    query[0] = 1;
    // The previously-pending "widget" chunk is now searchable.
    const hits = semanticSearch(db, query, new Set(["a/widget.ts", "b/other.ts"]));
    expect(hits.some((hit) => hit.line === 6 && hit.path === "b/other.ts")).toBe(true);
});

// Two iq processes topping up one backlog both read a chunk as pending before either writes it; the second write used
// to fail with "UNIQUE constraint failed on chunk_vectors primary key" (the shinobi-society audit, 2026-11-17).
test("writing a chunk's vector again replaces it rather than failing", () => {
    putVector(db, 2, 2, vec([1, 0]));
    putVector(db, 2, 2, vec([0, 1]));
    const stored = vectorsOfFile(db, "b/other.ts").get("c2");
    expect(stored).toBeInstanceOf(Uint8Array);
    copyVector(db, 2, 2, stored ?? new Uint8Array(384));
    expect(db.get("SELECT COUNT(*) AS n FROM chunk_vectors WHERE chunk_id = 2")?.["n"]).toBe(1);
    const query = new Float32Array(384);
    query[1] = 1;
    expect(semanticSearch(db, query, new Set(["b/other.ts"]))[0]).toMatchObject({ path: "b/other.ts", line: 1, tags: [{ kind: "sem", score: 1 }] });
});

test("a top-up racing another process's writes for the same chunks still completes", async () => {
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (2, 10, 12, 'c4', 'b/other.ts § raced widget')");
    const id = Number(db.get("SELECT id FROM chunks WHERE hash = 'c4'")?.["id"]);
    // The other process writes while this one is waiting on the model, after this one read the chunk as pending.
    const racing: Embedder = {
        ...fakeEmbedder,
        embedBatch: async (texts) => {
            putVector(db, id, 2, vec([1, 0]));
            return fakeEmbedder.embedBatch(texts);
        },
    };
    expect(await embedPending(db, racing)).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM chunk_vectors WHERE chunk_id = ?", id)?.["n"]).toBe(1);
});
