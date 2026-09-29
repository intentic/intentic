import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { embedPending } from "../engines/semantic.js";
import type { SqliteDb } from "@intentic/base/sqlite";
import { syncModel } from "../indexer/indexer.js";
import { openIndex } from "../store/db.js";
import { getMeta, setMeta } from "../store/index-store.js";
import { type Embedder, MODEL_ID, VECTOR_SPACE } from "./embedder.js";
import { openVectorCache, vectorCachePath } from "./vector-cache.js";

let root: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "iq-veccache-"));
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// Deterministic fake that counts every text it is asked to embed.
const countingEmbedder = (): { embedder: Embedder; embedded: string[] } => {
    const embedded: string[] = [];
    const vec = (text: string): Float32Array => {
        const f = new Float32Array(384);
        f[0] = text.length;
        return f;
    };
    return {
        embedded,
        embedder: {
            modelId: "fake",
            embedBatch: (texts) => {
                embedded.push(...texts);
                return Promise.resolve(texts.map(vec));
            },
            embedQuery: (query) => Promise.resolve(vec(query)),
        },
    };
};

// An embedder that must never be reached: reuse means the model stays cold.
const refusingEmbedder: Embedder = {
    modelId: "fake",
    embedBatch: () => Promise.reject(new Error("cache miss reached the model")),
    embedQuery: () => Promise.reject(new Error("cache miss reached the model")),
};

const insertChunks = (db: SqliteDb, texts: readonly string[]): void => {
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a.ts', 0, 1, 'f1')");
    const id = Number(db.get("SELECT id FROM files WHERE path = 'a.ts'")!["id"]);
    texts.forEach((text, i) => {
        db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (?, ?, ?, ?, ?)", id, i + 1, i + 2, sha(text), text);
    });
};

const storedVectors = (db: SqliteDb): Map<string, Uint8Array> => {
    const map = new Map<string, Uint8Array>();
    for (const row of db.all("SELECT c.hash, v.embedding FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.id")) {
        map.set(row["hash"] as string, row["embedding"] as Uint8Array);
    }
    return map;
};

test("vectors survive the index being dropped and refill without touching the model", async () => {
    const indexDir = join(root, "drop", "iq");
    const cachePath = vectorCachePath(indexDir);
    const texts = ["const widget = 1", "function other() {}"];

    // First life: a cold index computes both vectors through the model and the cache learns them.
    const first = openIndex(indexDir, "write");
    insertChunks(first, texts);
    const { embedder, embedded } = countingEmbedder();
    const cache = openVectorCache(cachePath, "fake");
    expect(await embedPending(first, embedder, cache)).toBe(0);
    expect(embedded).toEqual(texts);
    const original = storedVectors(first);
    first.close();
    cache!.close();

    // The schema-drift path: the index dir is dropped wholesale; the sidecar is untouched by design.
    rmSync(indexDir, { recursive: true, force: true });

    // Second life, fresh cache handle (a new process): every vector refills from the sidecar, an embedder
    // that rejects proves the model is never consulted.
    const second = openIndex(indexDir, "write");
    insertChunks(second, texts);
    const reopened = openVectorCache(cachePath, "fake");
    expect(await embedPending(second, refusingEmbedder, reopened)).toBe(0);
    const refilled = storedVectors(second);
    expect(refilled.size).toBe(2);
    for (const [hash, blob] of original) {
        expect(Buffer.from(refilled.get(hash)!)).toEqual(Buffer.from(blob));
    }
    second.close();
    reopened!.close();
});

test("identical text in two chunks is embedded once and fans out", async () => {
    const indexDir = join(root, "dedupe", "iq");
    const db = openIndex(indexDir, "write");
    const text = "shared body";
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a.ts', 0, 1, 'f1')");
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (1, 1, 2, ?, ?)", sha(text), text);
    db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (1, 3, 4, ?, ?)", sha(text), text);
    const { embedder, embedded } = countingEmbedder();
    const cache = openVectorCache(vectorCachePath(indexDir), "fake");
    expect(await embedPending(db, embedder, cache)).toBe(0);
    expect(embedded).toEqual([text]);
    expect(Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1")?.["n"])).toBe(2);
    db.close();
    cache!.close();
});

test("a model swap clears the cache", () => {
    const cachePath = vectorCachePath(join(root, "swap", "iq"));
    const cache = openVectorCache(cachePath, "model-a");
    const blob = new Uint8Array(384 * 4).fill(7);
    cache!.put(new Map([["h1", blob]]));
    expect(cache!.get(["h1"]).size).toBe(1);
    cache!.close();
    const swapped = openVectorCache(cachePath, "model-b");
    expect(swapped!.get(["h1"]).size).toBe(0);
    swapped!.close();
});

// What every released cache and index carries in `model_id`: the bare model id, from before the key named a vector space.
const RELEASED_SPACE = "Xenova/bge-small-en-v1.5";
// Any other space, e.g. the reference [CLS] pooling a later release might switch to.
const OTHER_SPACE = `${MODEL_ID}#pooling=cls`;

// Upgrading onto the current (mean-pooled) space must cost nobody a re-embed: both stores stay warm.
test("the current vector space is the released key, so an existing index and cache stay warm", async () => {
    expect(VECTOR_SPACE).toBe(RELEASED_SPACE);
    const indexDir = join(root, "warm", "iq");
    const cachePath = vectorCachePath(indexDir);
    const texts = ["const widget = 1", "function other() {}"];
    const db = openIndex(indexDir, "write");
    insertChunks(db, texts);
    setMeta(db, "model_id", RELEASED_SPACE);
    const released = openVectorCache(cachePath, RELEASED_SPACE);
    expect(await embedPending(db, countingEmbedder().embedder, released)).toBe(0);
    released!.close();
    const before = storedVectors(db);

    syncModel(db, "/models");
    expect(getMeta(db, "model_id")).toBe(RELEASED_SPACE);
    expect(Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"])).toBe(0);
    expect(storedVectors(db)).toEqual(before);
    const current = openVectorCache(cachePath, VECTOR_SPACE);
    expect([...current!.get([...before.keys()]).keys()].toSorted()).toEqual([...before.keys()].toSorted());
    // Nothing is pending, so the model is never reached.
    expect(await embedPending(db, refusingEmbedder, current)).toBe(0);
    db.close();
    current!.close();
});

// The change path end to end: an index and its sidecar both embedded under another space must refill from the model,
// never from either store's old vectors, since those are well-formed but belong to the other space.
test("a different vector space reopens empty and re-embeds every chunk instead of mixing old vectors in", async () => {
    const indexDir = join(root, "change", "iq");
    const cachePath = vectorCachePath(indexDir);
    const texts = ["const widget = 1", "function other() {}"];
    const db = openIndex(indexDir, "write");
    insertChunks(db, texts);
    setMeta(db, "model_id", OTHER_SPACE);
    const old = openVectorCache(cachePath, OTHER_SPACE);
    expect(await embedPending(db, countingEmbedder().embedder, old)).toBe(0);
    old!.close();

    syncModel(db, "/models");
    expect(getMeta(db, "model_id")).toBe(VECTOR_SPACE);
    expect(Number(db.get("SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0")?.["n"])).toBe(2);
    expect(storedVectors(db).size).toBe(0);
    const reopened = openVectorCache(cachePath, VECTOR_SPACE);
    expect(reopened!.get(texts.map(sha)).size).toBe(0);
    const { embedder, embedded } = countingEmbedder();
    expect(await embedPending(db, embedder, reopened)).toBe(0);
    expect(embedded).toEqual(texts);
    expect(storedVectors(db).size).toBe(2);
    db.close();
    reopened!.close();
    // Reopening under the same space keeps what it wrote: the clear happens once per change, not per open.
    const again = openVectorCache(cachePath, VECTOR_SPACE);
    expect(again!.get(texts.map(sha)).size).toBe(2);
    again!.close();
});

test("compaction evicts least-recently-used rows past the ceiling", async () => {
    const cachePath = vectorCachePath(join(root, "evict", "iq"));
    const cache = openVectorCache(cachePath, "fake", 2);
    const blob = new Uint8Array(4).fill(1);
    cache!.put(new Map([["a", blob]]));
    cache!.put(new Map([["b", blob]]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache!.get(["a"]); // touch a: b becomes the oldest
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache!.put(new Map([["c", blob]]));
    cache!.compact();
    const kept = cache!.get(["a", "b", "c"]);
    expect([...kept.keys()].toSorted()).toEqual(["a", "c"]);
    cache!.close();
});

// Waits out the open's own 5 s busy_timeout, since the lock has to outlast it to be a refusal at all.
test("a cache another process is writing is left alone, not dropped as corrupt", () => {
    const cachePath = vectorCachePath(join(root, "busy", "iq"));
    const owner = openVectorCache(cachePath, "fake");
    owner!.put(new Map([["kept", new Uint8Array(4).fill(3)]]));
    owner!.close();
    // Another process mid-write: the lock the next open's meta upsert has to wait on.
    const writer = new DatabaseSync(cachePath);
    writer.exec("BEGIN IMMEDIATE");
    expect(openVectorCache(cachePath, "fake")).toBeUndefined();
    writer.exec("ROLLBACK");
    writer.close();
    const reopened = openVectorCache(cachePath, "fake");
    expect([...reopened!.get(["kept"]).keys()]).toEqual(["kept"]);
    reopened!.close();
});

test("a corrupt cache file is dropped and reopened empty", async () => {
    const cachePath = vectorCachePath(join(root, "corrupt", "iq"));
    await mkdir(join(root, "corrupt"), { recursive: true });
    await writeFile(cachePath, "this is not a database");
    const cache = openVectorCache(cachePath, "fake");
    const blob = new Uint8Array(4).fill(9);
    cache!.put(new Map([["h", blob]]));
    expect(cache!.get(["h"]).size).toBe(1);
    cache!.close();
});
