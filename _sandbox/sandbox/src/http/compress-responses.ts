import type { Context, MiddlewareHandler } from "hono";
import { type Coding, codingFor, encodeOnce, encodeStream, isCompressibleText, isEventStream, isJson, MIN_COMPRESSED_BYTES } from "./compression.js";

// Compresses the daemon's text answers for the browser, which otherwise cross the tunnel at full size with every byte
// waiting on its flow-control window. Three shapes, each encoded its own way (codings and levels in compression.ts):
// - A whole answer (JSON, a script, a page) is read whole and encoded in one go, its encoded length declared.
// - A stream (an event stream, newline-delimited JSON, any text answer that declares neither a length nor an ETag, so
//   may still be being written) is encoded as it is written and flushed after every chunk, so each frame reaches the
//   browser at once. The agent stream's first frame carries a turn's whole transcript, resent on every attach.
// - A script or stylesheet with an ETag is the same bytes on every send until the ETag moves (a customer's visitors
//   all load /webchat/widget.js), so its first send encodes at the dynamic level and starts a once-only encode at the
//   static level, which every send after it is answered from.
// What never is: file bytes (images, media, octet-stream), whose Content-Length the browser counts progress against; a
// range of anything, whose offsets name the unencoded bytes; and an answer marked `Cache-Control: no-transform`. The
// release gate holds its JSON verdict open with heartbeat spaces under that mark: reading it whole would hold its
// headers until the verdict, and an edge proxy gives up on an origin silent that long (Cloudflare's 524 at ~100 s).

export { codingFor, MIN_COMPRESSED_BYTES } from "./compression.js";

// Above this a whole answer passes through as written: reading it whole to encode it would hold that much on the heap.
const MAX_WHOLE_BYTES = 32 * 1024 * 1024;

// The once-only static copies: bodies past this are encoded at the dynamic level every time, since brotli 11 costs
// about a second of the pool per megabyte; the copies together stay under the cache's size, oldest dropped first.
const MAX_STATIC_BODY_BYTES = 4 * 1024 * 1024;
const STATIC_CACHE_BYTES = 32 * 1024 * 1024;

// Streams read only by a process on this machine (an engine's model calls through the privacy gateway, a turn's MCP
// mounts): encoding them spends the daemon's CPU on a loopback hop that has no bandwidth to save.
const LOOPBACK_STREAMS = /^\/(privacy|mcp)\//u;

const forbidsTransform = (cacheControl: string | null): boolean => cacheControl !== null && /(^|,)\s*no-transform\s*(,|$)/iu.test(cacheControl);

// An answer that leaves exactly as the route wrote it, whatever the browser accepts.
const leftAlone = (method: string, response: Response): boolean =>
    method === "HEAD" ||
    response.body === null ||
    response.status === 206 ||
    response.headers.has("content-range") ||
    response.headers.has("content-encoding") ||
    !isCompressibleText(response.headers.get("content-type")) ||
    forbidsTransform(response.headers.get("cache-control"));

const staticCopies = new Map<string, Uint8Array<ArrayBuffer>>();
const staticPending = new Map<string, Promise<void>>();
let staticCopiesBytes = 0;

const keepStatic = (key: string, copy: Uint8Array<ArrayBuffer>): void => {
    staticCopies.set(key, copy);
    staticCopiesBytes += copy.byteLength;
    // A Map iterates oldest first.
    for (const [oldest, dropped] of staticCopies) {
        if (staticCopiesBytes <= STATIC_CACHE_BYTES) {
            break;
        }
        staticCopies.delete(oldest);
        staticCopiesBytes -= dropped.byteLength;
    }
};

// The static copy when one is ready; otherwise the dynamic encoding now, and the static one started for next time.
const encodeAsset = async (key: string, coding: Coding, body: Buffer): Promise<Uint8Array<ArrayBuffer>> => {
    const kept = staticCopies.get(key);
    if (kept !== undefined) {
        return kept;
    }
    if (!staticPending.has(key)) {
        const pending = encodeOnce(coding, body, "static")
            .then((copy) => keepStatic(key, copy))
            // allow(silent-catch): the static copy is an optimisation; without it the next send encodes again
            .catch(() => undefined)
            .finally(() => staticPending.delete(key));
        staticPending.set(key, pending);
    }
    return encodeOnce(coding, body);
};

// A whole answer, read whole and encoded in one go. It is already in memory (a JSON string, a held script), so reading
// it whole costs nothing a stream would save; the encoder runs on libuv's pool, off the daemon's loop.
const encodeWhole = async (c: Context, response: Response, coding: Coding, headers: Headers): Promise<Response> => {
    const raw = await response.arrayBuffer();
    const init = { status: response.status, statusText: response.statusText, headers };
    if (raw.byteLength < MIN_COMPRESSED_BYTES) {
        return new Response(raw, init);
    }
    const body = Buffer.from(raw);
    const etag = response.headers.get("etag");
    const asset =
        etag !== null && !isJson(response.headers.get("content-type")) && response.status === 200 && body.byteLength <= MAX_STATIC_BODY_BYTES;
    // Keyed by the URL and the ETag together: the ETag names these bytes only at this address.
    const encoded = asset ? await encodeAsset(`${coding} ${c.req.url} ${etag}`, coding, body) : await encodeOnce(coding, body);
    headers.set("content-encoding", coding);
    headers.set("content-length", String(encoded.byteLength));
    return new Response(encoded, init);
};

export const compressResponses = (): MiddlewareHandler => async (c, next) => {
    await next();
    const response = c.res;
    const coding = codingFor(c.req.header("accept-encoding"));
    if (coding === undefined || leftAlone(c.req.method, response) || response.body === null) {
        return;
    }
    const type = response.headers.get("content-type");
    const live = isEventStream(type) || (!isJson(type) && !response.headers.has("etag") && !response.headers.has("content-length"));
    if (live ? LOOPBACK_STREAMS.test(c.req.path) : Number(response.headers.get("content-length") ?? 0) > MAX_WHOLE_BYTES) {
        return;
    }
    const headers = new Headers(response.headers);
    headers.append("vary", "accept-encoding");
    // Byte ranges name offsets in the unencoded body, which an encoded answer no longer has.
    headers.delete("accept-ranges");
    if (live) {
        headers.delete("content-length");
        headers.set("content-encoding", coding);
    }
    const encoded = live
        ? new Response(encodeStream(response.body, coding), { status: response.status, statusText: response.statusText, headers })
        : await encodeWhole(c, response, coding, headers);
    // Cleared before each replacement: Hono's `c.res` setter copies every header of the answer it replaces onto the new
    // one, so a route's own Content-Length (an extension backend's, proxied under /x/) overwrote the encoded length, and
    // the browser waited forever for bytes that were never coming.
    c.res = undefined;
    c.res = encoded;
};

// Settles once every static encode started so far has landed; for a test that reads the copy a later send gets.
export const staticEncodesSettled = async (): Promise<void> => {
    await Promise.all(staticPending.values());
};
