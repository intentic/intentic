// Runnable, framework-free check for the bounded upload chunker (the web app has no test runner).
// Run: node _apps/web/scripts/uploadChunking.check.mjs  (Node 24 strips the imported .ts types natively.)
import assert from "node:assert/strict";
import { CHUNK_BYTES, CHUNK_FILES, chunkItems } from "../src/composables/workspace/uploadChunking.ts";

const mk = (n, size) => Array.from({ length: n }, (_, i) => ({ id: i, size }));
const bytesOf = (chunk) => chunk.reduce((sum, item) => sum + item.size, 0);
const flat = (chunks) => chunks.flat();

// Empty in → empty out.
assert.deepEqual(chunkItems([]), []);

// Under both caps → one chunk, order preserved.
{
    const items = mk(5, 10);
    const chunks = chunkItems(items);
    assert.equal(chunks.length, 1);
    assert.deepEqual(flat(chunks), items);
}

// File-count cap: 2*CHUNK_FILES + 1 tiny files → [CHUNK_FILES, CHUNK_FILES, 1], nothing dropped or reordered.
{
    const items = mk(2 * CHUNK_FILES + 1, 1);
    const chunks = chunkItems(items);
    assert.deepEqual(
        chunks.map((c) => c.length),
        [CHUNK_FILES, CHUNK_FILES, 1],
    );
    assert.deepEqual(flat(chunks), items);
}

// Byte cap: files each just over half the cap → one per chunk (two would exceed), each within the cap.
{
    const half = Math.floor(CHUNK_BYTES / 2) + 1;
    const chunks = chunkItems(mk(3, half));
    assert.deepEqual(
        chunks.map((c) => c.length),
        [1, 1, 1],
    );
    for (const c of chunks) assert.ok(bytesOf(c) <= CHUNK_BYTES);
}

// Two that fit together, then one that tips the running sum over → [2, 1].
{
    const size = Math.floor(CHUNK_BYTES * 0.4); // two fit (0.8), a third overflows (1.2)
    const chunks = chunkItems(mk(3, size));
    assert.deepEqual(
        chunks.map((c) => c.length),
        [2, 1],
    );
    for (const c of chunks) assert.ok(bytesOf(c) <= CHUNK_BYTES);
}

// A single file larger than the byte cap gets its OWN chunk and never absorbs its neighbors.
{
    const items = [
        { size: 10, tag: "a" },
        { size: CHUNK_BYTES * 3, tag: "big" },
        { size: 10, tag: "b" },
    ];
    const chunks = chunkItems(items);
    assert.deepEqual(
        chunks.map((c) => c.length),
        [1, 1, 1],
    );
    assert.equal(chunks[1][0].tag, "big");
    assert.deepEqual(
        flat(chunks).map((i) => i.tag),
        ["a", "big", "b"],
    );
}

// Invariant sweep: every chunk respects both caps (a lone over-cap file is the only exception), nothing lost.
{
    const items = mk(1000, Math.floor(CHUNK_BYTES / 50));
    const chunks = chunkItems(items);
    assert.equal(flat(chunks).length, 1000);
    for (const c of chunks) {
        assert.ok(c.length >= 1 && c.length <= CHUNK_FILES);
        assert.ok(c.length === 1 || bytesOf(c) <= CHUNK_BYTES);
    }
}

console.log("uploadChunking.check: OK");
