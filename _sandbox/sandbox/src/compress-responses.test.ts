import { zstdDecompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { codingFor, compressResponses, MIN_COMPRESSED_BYTES } from "./compress-responses.js";

// Pins what leaves compressed and what never does: JSON over the floor, encoded as the browser asked; everything else,
// and anything the browser did not ask for, byte for byte as the route wrote it.

const big = { rows: Array.from({ length: 400 }, (_, index) => ({ path: `src/module-${String(index)}.ts`, type: "file" })) };

const app = new Hono();
app.use("*", compressResponses());
app.get("/big", (c) => c.json(big));
app.get("/small", (c) => c.json({ ok: true }));
app.get("/events", (c) => c.body("data: one\n\n".repeat(200), 200, { "content-type": "text/event-stream" }));
app.get("/raw", (c) => c.body("plain text ".repeat(500), 200, { "content-type": "text/plain" }));

const get = async (path: string, acceptEncoding?: string): Promise<Response> =>
    app.request(path, acceptEncoding === undefined ? {} : { headers: { "accept-encoding": acceptEncoding } });

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

    test("a JSON answer under the floor, or one the browser accepts no coding for, leaves as written", async () => {
        const small = await get("/small", "zstd");
        expect(small.headers.get("content-encoding")).toBeNull();
        expect(JSON.stringify(await small.json()).length).toBeLessThan(MIN_COMPRESSED_BYTES);

        const unasked = await get("/big");
        expect(unasked.headers.get("content-encoding")).toBeNull();
        expect(await unasked.json()).toEqual(big);
    });

    test("an event stream and file bytes are never encoded, however large", async () => {
        expect((await get("/events", "zstd")).headers.get("content-encoding")).toBeNull();
        expect((await get("/raw", "zstd")).headers.get("content-encoding")).toBeNull();
    });
});
