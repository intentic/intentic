#!/usr/bin/env node
// THE FLEET'S TURBO CACHE, AS SANDBOXES REACH IT. Turbo's remote-cache HTTP API (the `/v8/artifacts` routes turbo 2
// speaks) over directories laid out as turbo's own filesystem cache, so it serves the CI runners' /ci-cache/turbo
// without CI talking to it at all: the runners keep reading and writing that directory as they always have.
//
// Reads come from every directory in TURBO_CACHE_READ_DIRS, first hit wins: a sandbox replays whatever CI built.
// Writes go only to TURBO_CACHE_WRITE_DIR, never to CI's own directory, and only as log-only entries (artifact.mjs):
// a sandbox's typecheck or test result, never a build output. CI takes nothing from that directory by itself. Its
// import step (import.mjs) copies an entry across only for a hash CI's own dry run gives to an output-less task, so a
// sandbox entry filed under a build's hash is never read by anything. An entry already held anywhere is never
// replaced, so a sandbox cannot overwrite what CI recorded.
//
// One bearer token, TURBO_CACHE_TOKEN, for every client: it is the sandboxes' token, and the credential gateway holds
// it for them. Node builtins only; README.md says how it is deployed.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { canonicalArtifact } from "./artifact.mjs";
import { HASH, hasEntry, prune, readEntry, writeEntry } from "./store.mjs";

// A log-only upload is kilobytes compressed; this is room for a long test log and nothing like a build.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
// A task's recorded duration is what turbo reports as time saved; a day is past any real one.
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
// Sandbox entries live as long as CI's own: pnpm-setup ages /ci-cache/turbo out at 14 days.
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const digest = (value) => createHash("sha256").update(value).digest();

const sendJson = (response, status, value) => {
    const payload = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
};

// A HEAD answer: the status alone, since HEAD carries no body.
const sendStatus = (response, status) => {
    response.writeHead(status);
    response.end();
};

// The request body, or undefined when it passes `limit`. Past the limit the rest is read and dropped rather than the
// socket cut, so the client hears the 413 instead of a closed connection; memory stays bounded either way.
const bodyOf = (request, limit) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size <= limit) {
                chunks.push(chunk);
            }
        });
        request.on("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks)));
        request.on("error", reject);
    });

// GET or HEAD of one entry: the first directory holding it answers, with the duration turbo reports as time saved.
const readArtifact = (request, response, { hash, held }) => {
    const dir = held(hash);
    const entry = dir === undefined ? undefined : readEntry(dir, hash);
    const head = request.method === "HEAD";
    if (entry === undefined) {
        return head ? sendStatus(response, 404) : sendJson(response, 404, { code: "not_found" });
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": entry.body.length, "x-artifact-duration": String(entry.durationMs) });
    return response.end(head ? undefined : entry.body);
};

// PUT of one entry: kept only as a log-only entry, only in the write directory, and never over one already held.
const writeArtifact = async (request, response, { hash, held, writeDir, log }) => {
    const body = await bodyOf(request, MAX_UPLOAD_BYTES);
    if (body === undefined) {
        return sendJson(response, 413, { code: "too_large", message: `a log-only entry is under ${MAX_UPLOAD_BYTES} bytes` });
    }
    // What CI or an earlier upload recorded stays: the first result for a hash is the one kept.
    if (held(hash) !== undefined) {
        return sendJson(response, 200, { urls: [] });
    }
    const artifact = canonicalArtifact(body);
    if (!artifact.ok) {
        log(`refused ${hash}: ${artifact.reason}`);
        return sendJson(response, 403, { code: "forbidden", message: `this cache keeps task logs only; the upload held ${artifact.reason}` });
    }
    const duration = Number(request.headers["x-artifact-duration"]);
    writeEntry(writeDir, hash, artifact.body, Number.isFinite(duration) ? Math.min(Math.max(duration, 0), MAX_DURATION_MS) : 0);
    log(`kept ${hash} (${artifact.files.map((file) => file.path).join(", ")})`);
    return sendJson(response, 200, { urls: [] });
};

// The authorised `/v8/artifacts` routes, after the token has been checked.
const route = (request, response, context) => {
    const { pathname } = context.url;
    if (pathname === "/v8/artifacts/status") {
        return sendJson(response, 200, { status: "enabled" });
    }
    if (pathname === "/v8/artifacts/events") {
        request.resume();
        return sendJson(response, 200, {});
    }
    const hash = /^\/v8\/artifacts\/([^/]+)$/.exec(pathname)?.[1] ?? "";
    if (!HASH.test(hash)) {
        return sendJson(response, 400, { code: "bad_request", message: "not a task hash" });
    }
    if (request.method === "GET" || request.method === "HEAD") {
        return readArtifact(request, response, { ...context, hash });
    }
    if (request.method === "PUT") {
        return writeArtifact(request, response, { ...context, hash });
    }
    return sendJson(response, 405, { code: "method_not_allowed" });
};

/** The handler, separate from listening so tests can drive it on an ephemeral port. */
export const createCacheServer = ({ token, readDirs, writeDir, log = () => {} }) => {
    const secret = token ?? "";
    if (secret.length < 16) {
        throw new Error("the cache token must be at least 16 characters");
    }
    const expected = digest(secret);
    const authorized = (header) => {
        const presented = /^Bearer (.+)$/.exec(header ?? "")?.[1];
        return presented !== undefined && timingSafeEqual(digest(presented), expected);
    };
    const dirs = [...new Set([...readDirs, writeDir])];
    const held = (hash) => dirs.find((dir) => hasEntry(dir, hash));

    return createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://cache");
            if (url.pathname === "/healthz") {
                response.writeHead(200, { "content-type": "text/plain" });
                return response.end("ok");
            }
            if (!url.pathname.startsWith("/v8/artifacts")) {
                return sendJson(response, 404, { code: "not_found" });
            }
            if (!authorized(request.headers.authorization)) {
                return sendJson(response, 401, { code: "unauthorized", message: "a bearer token this cache knows" });
            }
            return await route(request, response, { url, held, writeDir, log });
        } catch (error) {
            log(`failed ${request.method} ${request.url}: ${String(error?.stack ?? error)}`);
            if (!response.headersSent) {
                sendJson(response, 500, { code: "internal" });
            }
        }
    });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const readDirs = (process.env.TURBO_CACHE_READ_DIRS ?? "/cache/ci").split(":").filter(Boolean);
    const writeDir = process.env.TURBO_CACHE_WRITE_DIR ?? "/cache/sandbox";
    const port = Number(process.env.PORT ?? 3000);
    const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
    const server = createCacheServer({ token: process.env.TURBO_CACHE_TOKEN, readDirs, writeDir, log });
    server.listen(port, process.env.HOST ?? "0.0.0.0", () => log(`turbo-cache: reading ${readDirs.join(", ")}, writing ${writeDir}, on :${port}`));
    // Only the directory this server writes is its to age out; CI's own is pnpm-setup's.
    const sweep = () => log(`turbo-cache: pruned ${prune(writeDir, MAX_AGE_MS)} files from ${writeDir}`);
    sweep();
    setInterval(sweep, 60 * 60 * 1000).unref();
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => server.close(() => process.exit(0)));
    }
}
