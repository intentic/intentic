import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Embedder } from "../embed/embedder.js";
import { openIndex, type IndexDb } from "../store/db.js";
import { embedPending, semanticSearch } from "./semantic.js";

let dir: string;
let db: IndexDb;

const vec = (values: number[]): Uint8Array => {
    const f = new Float32Array(384);
    values.forEach((value, i) => (f[i] = value));
    return new Uint8Array(f.buffer);
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
    db = openIndex(dir);
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a/widget.ts', 0, 1, 'h1')");
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('b/other.ts', 0, 1, 'h2')");
    db.run(
        "INSERT INTO chunks (file_id, start_line, end_line, hash, text, embedding) VALUES (1, 1, 5, 'c1', 'a/widget.ts § widget\\ncreates a widget', ?)",
        vec([1, 0]),
    );
    db.run(
        "INSERT INTO chunks (file_id, start_line, end_line, hash, text, embedding) VALUES (2, 1, 5, 'c2', 'b/other.ts § other\\nsomething else', ?)",
        vec([0, 1]),
    );
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (2, 6, 9, 'c3', 'b/other.ts § pending widget text')");
});
afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

test("semanticSearch ranks by dot product and respects the allowed set", () => {
    const query = new Float32Array(384);
    query[0] = 1;
    const hits = semanticSearch(db, query, new Set(["a/widget.ts", "b/other.ts"]));
    expect(hits[0]?.path).toBe("a/widget.ts");
    expect(hits[0]?.tags[0]).toEqual({ kind: "sem", score: 1 });
    expect(semanticSearch(db, query, new Set(["b/other.ts"])).every((hit) => hit.path === "b/other.ts")).toBe(true);
});

test("embedPending fills NULL embeddings and reports the remainder", async () => {
    expect(await embedPending(db, fakeEmbedder)).toBe(0);
    const query = new Float32Array(384);
    query[0] = 1;
    // The previously-pending "widget" chunk is now searchable.
    const hits = semanticSearch(db, query, new Set(["a/widget.ts", "b/other.ts"]));
    expect(hits.some((hit) => hit.line === 6 && hit.path === "b/other.ts")).toBe(true);
});
