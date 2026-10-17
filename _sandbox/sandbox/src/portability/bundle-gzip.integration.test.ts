import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { alreadyCompressed, levelledGzip } from "./bundle-gzip.js";

// The level follows what is packed: stored for bytes that are already compressed, deflated for the rest, in one gzip
// stream any gunzip reads whole.

test("history's zstd records, git's objects and media are already compressed; text and databases are not", () => {
    for (const name of [
        "history/conversations/a/transcript.jsonl.zst",
        "history/blobs/ab/cd.zst",
        "history/gits/app.git/objects/pack/pack-1f2e.pack",
        "history/gits/app.git/objects/ab/0123456789abcdef0123456789abcdef01234567",
        "workspace/app/logo.PNG",
    ]) {
        expect([name, alreadyCompressed(name)]).toEqual([name, true]);
    }
    for (const name of [
        "workspace/app/src/index.ts",
        "history/conversations.db",
        "history/gits/app.git/objects/pack/pack-1f2e.idx",
        "intentic-bundle.json",
    ]) {
        expect([name, alreadyCompressed(name)]).toEqual([name, false]);
    }
});

test("bytes packed under an already-compressed name go in stored, the rest deflated, and the whole decodes as written", async () => {
    const { gzip, packing } = levelledGzip();
    const out: Buffer[] = [];
    gzip.on("data", (chunk: Buffer) => out.push(chunk));
    const ended = new Promise((resolve) => gzip.once("end", resolve));
    // The same compressible megabyte twice: deflated it shrinks to almost nothing, stored it stays its size.
    const text = Buffer.from("const value = 1;\n".repeat(64 * 1024));
    await packing("workspace/a.ts");
    gzip.write(text);
    await packing("history/blobs/a.zst");
    gzip.write(text);
    await packing("workspace/b.ts");
    gzip.write(text);
    gzip.end();
    await ended;
    const encoded = Buffer.concat(out);
    expect(gunzipSync(encoded).equals(Buffer.concat([text, text, text]))).toBe(true);
    // The system's own gzip agrees: header, CRC and length all check out.
    expect(execFileSync("gzip", ["-dc"], { input: encoded, maxBuffer: 16 * 1024 * 1024 }).equals(Buffer.concat([text, text, text]))).toBe(true);
    expect(encoded.length).toBeGreaterThan(text.length);
    expect(encoded.length).toBeLessThan(text.length * 1.05);
});
