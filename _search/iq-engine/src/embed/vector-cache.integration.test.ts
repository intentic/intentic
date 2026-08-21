import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { embedPending } from "../engines/semantic.js";
import { openIndex, type IndexDb } from "../store/db.js";
import type { Embedder } from "./embedder.js";
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

const insertChunks = (db: IndexDb, texts: readonly string[]): void => {
    db.run("INSERT INTO files (path, mtime_ms, size, hash) VALUES ('a.ts', 0, 1, 'f1')");
    const id = Number(db.get("SELECT id FROM files WHERE path = 'a.ts'")!["id"]);
    texts.forEach((text, i) => {
        db.run("INSERT INTO chunks (file_id, start_line, end_line, hash, text) VALUES (?, ?, ?, ?, ?)", id, i + 1, i + 2, sha(text), text);
    });
};

const storedVectors = (db: IndexDb): Map<string, Uint8Array> => {
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
    expect(cache).toBeDefined();
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

test("a corrupt cache file is dropped and reopened empty", async () => {
    const cachePath = vectorCachePath(join(root, "corrupt", "iq"));
    await mkdir(join(root, "corrupt"), { recursive: true });
    await writeFile(cachePath, "this is not a database");
    const cache = openVectorCache(cachePath, "fake");
    expect(cache).toBeDefined();
    const blob = new Uint8Array(4).fill(9);
    cache!.put(new Map([["h", blob]]));
    expect(cache!.get(["h"]).size).toBe(1);
    cache!.close();
});
