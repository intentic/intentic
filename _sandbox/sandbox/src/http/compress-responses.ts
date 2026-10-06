import { promisify } from "node:util";
import { brotliCompress, constants, gzip, zstdCompress } from "node:zlib";
import type { MiddlewareHandler } from "hono";

// Compresses the daemon's JSON answers for the browser, which otherwise cross the tunnel at full size with every byte
// waiting on its flow-control window. JSON only: file bytes keep their Content-Length for progress, and an event stream
// must reach the browser frame by frame. A JSON answer marked `Cache-Control: no-transform` is a stream too (the release
// gate holds its verdict open with heartbeat spaces), so it leaves as written: reading it whole would hold its headers
// until the verdict, and an edge proxy gives up on an origin silent that long (Cloudflare's 524 at ~100 s).

// Below this an answer fits a packet or two either way, and encoding costs more than it saves.
export const MIN_COMPRESSED_BYTES = 1024;

type Coding = "zstd" | "br" | "gzip";

// Cheapest to encode first; at these levels each shrinks the daemon's JSON about sevenfold.
const PREFERENCE: readonly Coding[] = ["zstd", "br", "gzip"];

// Levels that stay in single milliseconds on a megabyte; the bytes saved are on the network, not in the encoder.
const encoders: Readonly<Record<Coding, (body: Buffer) => Promise<Buffer>>> = {
    zstd: (body) => promisify(zstdCompress)(body, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
    br: (body) => promisify(brotliCompress)(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
    gzip: (body) => promisify(gzip)(body, { level: 6 }),
};

// The best coding the request accepts; a coding named with q=0 is refused, anything else named is accepted.
export const codingFor = (acceptEncoding: string | undefined): Coding | undefined => {
    const accepted = new Set(
        (acceptEncoding ?? "")
            .split(",")
            .map((entry) => entry.trim().toLowerCase().split(";"))
            .filter(([, quality]) => quality === undefined || !/^\s*q\s*=\s*0(\.0*)?\s*$/u.test(quality))
            .map(([name]) => name),
    );
    return PREFERENCE.find((coding) => accepted.has(coding));
};

const isJson = (contentType: string | null): boolean => contentType !== null && /^application\/([\w.+-]*\+)?json\b/iu.test(contentType);

const forbidsTransform = (cacheControl: string | null): boolean => cacheControl !== null && /(^|,)\s*no-transform\s*(,|$)/iu.test(cacheControl);

export const compressResponses = (): MiddlewareHandler => async (c, next) => {
    await next();
    const response = c.res;
    if (
        c.req.method === "HEAD" ||
        response.body === null ||
        response.headers.has("content-encoding") ||
        !isJson(response.headers.get("content-type")) ||
        forbidsTransform(response.headers.get("cache-control"))
    ) {
        return;
    }
    const coding = codingFor(c.req.header("accept-encoding"));
    if (coding === undefined) {
        return;
    }
    // A JSON answer is already a string in memory, so reading it whole costs nothing a stream would save; the encoder
    // runs on libuv's pool, off the daemon's loop.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.append("vary", "accept-encoding");
    // Cleared before each replacement: Hono's `c.res` setter copies every header of the answer it replaces onto the new
    // one, so a route's own Content-Length (an extension backend's, proxied under /x/) overwrote the encoded length, and
    // the browser waited forever for bytes that were never coming.
    c.res = undefined;
    if (body.byteLength < MIN_COMPRESSED_BYTES) {
        c.res = new Response(body, { status: response.status, statusText: response.statusText, headers });
        return;
    }
    // Copied into a plain view: a Response takes an ArrayBuffer-backed body, and the encoded bytes are small.
    const encoded = new Uint8Array(await encoders[coding](Buffer.from(body)));
    headers.set("content-encoding", coding);
    headers.set("content-length", String(encoded.byteLength));
    c.res = new Response(encoded, { status: response.status, statusText: response.statusText, headers });
};
