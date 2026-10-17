import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import { decodedBody } from "./request-body.js";

// An upload's body as a route reads it: plain as sent, decoded for a coding the daemon names on its hello, refused for
// any other, and failing its reader when the bytes are not what they claim to be.

const text = "export const value = 1;\n".repeat(500);
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([new Uint8Array(bytes)]).stream();
const read = async (body: ReadableStream<Uint8Array> | null): Promise<string> => (body === null ? "" : new Response(body).text());

test("a plain body is read as sent, and a missing one stays missing", async () => {
    for (const coding of [undefined, "", "identity", " Identity "]) {
        const decoded = decodedBody(streamOf(new TextEncoder().encode(text)), coding);
        expect("body" in decoded && (await read(decoded.body))).toBe(text);
    }
    expect(decodedBody(null, "gzip")).toEqual({ body: null });
});

test("a gzip, zstd or brotli body is decoded as it streams", async () => {
    for (const [coding, encoded] of [
        ["gzip", gzipSync(text)],
        ["x-gzip", gzipSync(text)],
        ["GZIP", gzipSync(text)],
        ["zstd", zstdCompressSync(text)],
        ["br", brotliCompressSync(text)],
    ] as const) {
        const decoded = decodedBody(streamOf(encoded), coding);
        expect("body" in decoded && (await read(decoded.body))).toBe(text);
    }
});

test("a coding the daemon does not decode, or several stacked, is refused by name", () => {
    expect(decodedBody(streamOf(new Uint8Array([1])), "compress")).toEqual({ unsupported: "compress" });
    expect(decodedBody(streamOf(new Uint8Array([1])), "gzip, br")).toEqual({ unsupported: "gzip, br" });
    // An inherited property is no coding.
    expect(decodedBody(streamOf(new Uint8Array([1])), "constructor")).toEqual({ unsupported: "constructor" });
});

test("a body that is not the coding it claims fails its reader", async () => {
    const decoded = decodedBody(streamOf(new TextEncoder().encode(text)), "gzip");
    expect("body" in decoded).toBe(true);
    await expect(read("body" in decoded ? decoded.body : null)).rejects.toThrow();
});
