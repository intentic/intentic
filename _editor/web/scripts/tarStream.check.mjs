// Runnable, framework-free check for the streaming tar packer (the web app has no test runner).
// Run: node _editor/web/scripts/tarStream.check.mjs  (Node 24 strips the imported .ts types natively.)
import assert from "node:assert/strict";
import { packTar } from "../src/pages/workspace/tarStream.ts";

const td = new TextDecoder();
const readCStr = (buf, off, len) => {
    let end = off;
    while (end < off + len && buf[end] !== 0) end++;
    return td.decode(buf.subarray(off, end));
};
const readOctal = (buf, off, len) => parseInt(readCStr(buf, off, len).trim() || "0", 8);
const pad = (n) => (512 - (n % 512)) % 512;
const isZero = (buf, off) => buf.subarray(off, off + 512).every((b) => b === 0);

// Minimal tar reader: walk 512-byte headers, applying a pax `path` record to the entry that follows it.
const parseTar = (buf) => {
    const entries = [];
    let i = 0;
    let paxPath;
    while (i + 512 <= buf.length && !isZero(buf, i)) {
        const type = String.fromCharCode(buf[i + 156]);
        const name = readCStr(buf, i, 100);
        const size = readOctal(buf, i + 124, 12);
        i += 512;
        const content = buf.subarray(i, i + size);
        i += size + pad(size);
        if (type === "x") {
            paxPath = td.decode(content).match(/ path=(.*)\n/)?.[1];
            continue;
        }
        entries.push({ path: paxPath ?? name, content: td.decode(content), size });
        paxPath = undefined;
    }
    return entries;
};

const drain = async (stream) => {
    const chunks = [];
    const reader = stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
};

const entry = (path, content) => ({ path, file: new File([new TextEncoder().encode(content)], path.split("/").at(-1)) });

// Round-trip: short path, nested path, an empty file, and a path over 100 bytes (forces a pax header).
const longPath = `${"nested/".repeat(20)}deep-file-with-a-fairly-long-name.txt`;
assert.ok(new TextEncoder().encode(longPath).length > 100, "long path must exceed the 100-byte ustar name field");
const started = [];
let bytes = 0;
const packed = await drain(
    packTar([entry("a.txt", "hello"), entry("dir/b.txt", "world"), entry("empty.txt", ""), entry(longPath, "deep")], {
        onFileStart: (p) => started.push(p),
        onBytes: (n) => (bytes += n),
    }),
);

const parsed = parseTar(packed);
assert.deepEqual(
    parsed.map((e) => e.path),
    ["a.txt", "dir/b.txt", "empty.txt", longPath],
);
assert.deepEqual(
    parsed.map((e) => e.content),
    ["hello", "world", "", "deep"],
);

// The archive ends with two zero blocks, and its length is 512-aligned.
assert.equal(packed.length % 512, 0);
assert.ok(isZero(packed, packed.length - 512) && isZero(packed, packed.length - 1024), "must end with two zero blocks");

// Hooks: every file announced in order; byte total = sum of contents ("hello"+"world"+""+"deep" = 14).
assert.deepEqual(started, ["a.txt", "dir/b.txt", "empty.txt", longPath]);
assert.equal(bytes, 14);

// Drift: a File whose declared .size disagrees with what .stream() yields (the backing file changed between the
// drop scan and the upload: e.g. a rebuilt build artifact). The packer must still emit EXACTLY .size body bytes
// so framing stays aligned and a trailing entry is never corrupted. `chunks` is what .stream() emits; `errorAtEnd`
// makes the read throw partway (a replaced/unreadable file).
const enc = new TextEncoder();
const driftFile = (size, chunks, errorAtEnd = false) => ({
    size,
    lastModified: 0,
    stream() {
        let i = 0;
        return new ReadableStream({
            pull(controller) {
                if (i < chunks.length) {
                    controller.enqueue(chunks[i++]);
                    return;
                }
                if (errorAtEnd) {
                    controller.error(new Error("NotReadableError: file changed after reference was acquired"));
                    return;
                }
                controller.close();
            },
        });
    },
});
const sentinel = entry("sentinel.txt", "SENTINEL");

const checkDrift = async (label, file, expectedSize, expectedPrefix, expectedBytes) => {
    let counted = 0;
    const buf = await drain(packTar([{ path: "drift.bin", file }, sentinel], { onBytes: (n) => (counted += n) }));
    assert.equal(buf.length % 512, 0, `${label}: archive must stay 512-aligned`);
    const driftParsed = parseTar(buf);
    assert.deepEqual(
        driftParsed.map((e) => e.path),
        ["drift.bin", "sentinel.txt"],
        `${label}: both entries must parse`,
    );
    assert.equal(driftParsed[0].size, expectedSize, `${label}: header must declare the scan-time size`);
    assert.equal(driftParsed[0].content.slice(0, expectedPrefix.length), expectedPrefix, `${label}: real bytes preserved`);
    assert.equal(driftParsed[0].content.length, expectedSize, `${label}: body length must equal declared size`);
    assert.equal(driftParsed[1].content, "SENTINEL", `${label}: trailing entry must be intact (framing not desynced)`);
    // onBytes runs across both packed entries, so the total is the drift entry's emitted bytes plus the sentinel's.
    assert.equal(counted, expectedBytes + "SENTINEL".length, `${label}: onBytes must count only emitted content bytes`);
};

// File grew since scan: declared 3, stream yields 5 → truncated to 3, only 3 counted.
await checkDrift("grew", driftFile(3, [enc.encode("XXXXX")]), 3, "XXX", 3);
// File shrank: declared 8, stream yields 2 → zero-filled to 8, 2 counted; content is "ab" then NULs.
await checkDrift("shrank", driftFile(8, [enc.encode("ab")]), 8, "ab", 2);
// Read throws mid-file: declared 6, yields 2 then errors → packer warns, zero-fills to 6, does NOT reject.
await checkDrift("threw", driftFile(6, [enc.encode("ab")], true), 6, "ab", 2);

console.log("tarStream.check: OK");
