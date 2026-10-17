import { brotliCompressSync, brotliDecompressSync, constants, createZstdDecompress, gunzipSync, zstdDecompressSync } from "node:zlib";
import { Hono } from "hono";
import { codingFor, compressResponses, MIN_COMPRESSED_BYTES, staticEncodesSettled } from "./compress-responses.js";

// Pins what leaves compressed and what never does: text over the floor, encoded as the browser asked, a stream frame
// by frame; file bytes, ranges, no-transform answers, loopback streams and anything the browser did not ask for, byte
// for byte as the route wrote it.

const big = { rows: Array.from({ length: 400 }, (_, index) => ({ path: `src/module-${String(index)}.ts`, type: "file" })) };
const script = Array.from({ length: 600 }, (_, index) => `export const value${String(index)} = () => ${String(index)} * 2;`).join("\n");

// The second frame of /live is written only once the test has read the first, so the first must leave on its own.
let releaseSecondFrame: () => void = () => undefined;

const app = new Hono();
app.use("*", compressResponses());
app.get("/big", (c) => c.json(big));
app.get("/small", (c) => c.json({ ok: true }));
app.get("/events", (c) => c.body("data: one\n\n".repeat(200), 200, { "content-type": "text/event-stream" }));
app.get("/raw", (c) => c.body("plain text ".repeat(500), 200, { "content-type": "text/plain" }));
app.get("/file", (c) => c.body("plain text ".repeat(500), 200, { "content-type": "application/octet-stream", "content-length": "5500" }));
app.get("/picture", (c) => c.body("<svg>".repeat(500), 200, { "content-type": "image/svg+xml" }));
app.get("/range", (c) => c.body("plain text ".repeat(500), 206, { "content-type": "text/plain", "content-range": "bytes 0-5499/9000" }));
app.get("/held", (c) => c.body(JSON.stringify(big), 200, { "content-type": "application/json", "cache-control": "no-store, no-transform" }));
app.get("/mcp/turn", (c) => c.body("data: one\n\n".repeat(200), 200, { "content-type": "text/event-stream" }));
app.get("/widget.js", (c) =>
    c.body(script, 200, { "content-type": "application/javascript; charset=utf-8", etag: '"v1"', "accept-ranges": "bytes" }),
);
app.get(
    "/live",
    () =>
        new Response(
            new ReadableStream<Uint8Array>({
                start: async (controller) => {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(big)}\n\n`));
                    await new Promise<void>((resolve) => {
                        releaseSecondFrame = resolve;
                    });
                    controller.enqueue(new TextEncoder().encode("data: two\n\n"));
                    controller.close();
                },
            }),
            { headers: { "content-type": "text/event-stream" } },
        ),
);
// An answer that arrives with its own Content-Length, as an extension backend's does through the /x/ proxy.
app.get("/proxied", () => {
    const text = JSON.stringify(big);
    return new Response(text, { headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
});

const get = async (path: string, acceptEncoding?: string): Promise<Response> =>
    app.request(path, acceptEncoding === undefined ? {} : { headers: { "accept-encoding": acceptEncoding } });

const zstdText = async (response: Response): Promise<string> => zstdDecompressSync(Buffer.from(await response.arrayBuffer())).toString("utf8");

describe("codingFor", () => {
    test("prefers zstd, then brotli, then gzip, among what the request names", () => {
        expect(codingFor("gzip, deflate, br, zstd")).toBe("zstd");
        expect(codingFor("gzip, deflate, br")).toBe("br");
        expect(codingFor("gzip")).toBe("gzip");
        expect(codingFor("identity")).toBeUndefined();
        expect(codingFor(undefined)).toBeUndefined();
    });

    test("a coding refused with q=0 is never chosen", () => {
        expect(codingFor("zstd;q=0, br;q=0.5, gzip")).toBe("br");
        expect(codingFor("zstd; q=0.0, br;q=0")).toBeUndefined();
    });
});

describe("compressResponses", () => {
    test("a JSON answer over the floor leaves in the coding asked for, and decodes to what the route wrote", async () => {
        for (const [asked, decode] of [
            ["zstd", zstdDecompressSync],
            ["br", brotliDecompressSync],
            ["gzip", gunzipSync],
        ] as const) {
            const response = await get("/big", asked);
            expect(response.headers.get("content-encoding")).toBe(asked);
            expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
            const bytes = Buffer.from(await response.arrayBuffer());
            expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
            expect(JSON.parse(decode(bytes).toString("utf8"))).toEqual(big);
        }
    });

    test("an answer carrying its own Content-Length leaves with the encoded length, not the one it came with", async () => {
        const response = await get("/proxied", "zstd");
        expect(response.headers.get("content-encoding")).toBe("zstd");
        expect(response.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
        expect(JSON.parse(zstdDecompressSync(bytes).toString("utf8"))).toEqual(big);
    });

    test("a JSON answer under the floor, or one the browser accepts no coding for, leaves as written", async () => {
        const small = await get("/small", "zstd");
        expect(small.headers.get("content-encoding")).toBeNull();
        expect(JSON.stringify(await small.json()).length).toBeLessThan(MIN_COMPRESSED_BYTES);

        const unasked = await get("/big");
        expect(unasked.headers.get("content-encoding")).toBeNull();
        expect(await unasked.json()).toEqual(big);
    });

    test("an event stream and a text answer of unknown length leave encoded as a stream, with no length declared", async () => {
        for (const [path, written] of [
            ["/events", "data: one\n\n".repeat(200)],
            ["/raw", "plain text ".repeat(500)],
        ] as const) {
            const response = await get(path, "zstd");
            expect(response.headers.get("content-encoding")).toBe("zstd");
            expect(response.headers.get("content-length")).toBeNull();
            expect(await zstdText(response)).toBe(written);
        }
    });

    test("each frame of a stream reaches the reader before the next is written", async () => {
        const response = await get("/live", "zstd");
        expect(response.headers.get("content-encoding")).toBe("zstd");
        const decoder = createZstdDecompress();
        let decoded = "";
        decoder.on("data", (chunk: Buffer) => {
            decoded += chunk.toString("utf8");
        });
        const reader = response.body?.getReader();
        // The first frame is all there is until releaseSecondFrame, so it can only decode whole if it was flushed.
        while (!decoded.endsWith("\n\n")) {
            // one stream, read in order
            const { value } = (await reader?.read()) ?? {};
            // Waits for the decoder to take the chunk in, then for what it decoded to be handed on.
            // one decoder, fed in order
            await new Promise((resolve) => decoder.write(value, resolve));
            // one decoder, drained in order
            await new Promise((resolve) => setImmediate(resolve));
        }
        expect(decoded).toBe(`data: ${JSON.stringify(big)}\n\n`);
        releaseSecondFrame();
        for (let next = await reader?.read(); next !== undefined && !next.done; next = await reader?.read()) {
            decoder.write(next.value);
        }
        decoder.end();
        await new Promise((resolve) => decoder.once("end", resolve));
        expect(decoded).toEndWith("data: two\n\n");
    });

    test("file bytes, an image, a range, and a stream only this machine reads are never encoded", async () => {
        for (const path of ["/file", "/picture", "/range", "/mcp/turn"]) {
            const response = await get(path, "zstd");
            expect(response.headers.get("content-encoding")).toBeNull();
            expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(MIN_COMPRESSED_BYTES);
        }
    });

    test("a script with an ETag is answered from a once-only static encoding after its first send", async () => {
        const first = await get("/widget.js", "br");
        expect(first.headers.get("content-encoding")).toBe("br");
        expect(first.headers.get("etag")).toBe('"v1"');
        // Ranges name offsets in the unencoded bytes.
        expect(first.headers.get("accept-ranges")).toBeNull();
        const firstBytes = Buffer.from(await first.arrayBuffer());
        expect(brotliDecompressSync(firstBytes).toString("utf8")).toBe(script);

        await staticEncodesSettled();
        const later = await get("/widget.js", "br");
        const laterBytes = Buffer.from(await later.arrayBuffer());
        expect(Number(later.headers.get("content-length"))).toBe(laterBytes.length);
        // Byte for byte brotli 11's encoding, which the dynamic level never produces.
        const params = { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(script) };
        expect(laterBytes.equals(brotliCompressSync(script, { params }))).toBe(true);
        expect(brotliDecompressSync(laterBytes).toString("utf8")).toBe(script);
    });

    test("a JSON answer marked no-transform leaves as written, since reading it whole would hold a streamed verdict", async () => {
        const held = await get("/held", "gzip, br");
        expect(held.headers.get("content-encoding")).toBeNull();
        expect(held.headers.get("vary")).toBeNull();
        expect(await held.json()).toEqual(big);
    });
});
