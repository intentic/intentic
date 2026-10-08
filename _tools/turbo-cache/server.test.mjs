// Pins the cache server's contract with turbo and with the fleet: reads from CI's directory first, writes only log-only
// entries and only to its own directory, never replaces what CI recorded, and answers no one without the token.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { after, before, test } from "node:test";
import { readTar, writeTar } from "./artifact.mjs";
import { createCacheServer, MAX_UPLOAD_BYTES } from "./server.mjs";
import { writeEntry } from "./store.mjs";

const TOKEN = "a-test-token-of-some-length";
const LOG = "packages/a/.turbo/turbo-typecheck.log";
const logOnly = (text = "typechecked\n") => zstdCompressSync(writeTar([{ path: LOG, data: Buffer.from(text) }]));

let root;
let ciDir;
let sandboxDir;
let server;
let base;

before(async () => {
    root = mkdtempSync(join(tmpdir(), "turbo-cache-server-"));
    ciDir = join(root, "ci");
    sandboxDir = join(root, "sandbox");
    server = createCacheServer({ token: TOKEN, readDirs: [ciDir], writeDir: sandboxDir });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
});

// `token: null` sends no authorization at all; left out, the request carries the right one.
const headersFor = (token, extra) => {
    const headers = { ...extra };
    if (token !== null) {
        headers.authorization = `Bearer ${token}`;
    }
    return headers;
};
const call = (path, { method = "GET", token = TOKEN } = {}) => fetch(`${base}${path}`, { method, headers: headersFor(token, {}) });
// The two requests that carry a body: an upload, and turbo's events.
const put = (path, body, { token = TOKEN, headers = {} } = {}) => fetch(`${base}${path}`, { method: "PUT", body, headers: headersFor(token, headers) });
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", body, headers: headersFor(TOKEN, {}) });

test("nothing answers without the token, except the health check", async () => {
    assert.equal((await call("/v8/artifacts/status", { token: null })).status, 401);
    assert.equal((await call("/v8/artifacts/status", { token: "wrong-token-of-some-length" })).status, 401);
    assert.equal((await put("/v8/artifacts/1111111111111111", logOnly(), { token: null })).status, 401);
    assert.equal((await call("/healthz", { token: null })).status, 200);
    assert.deepEqual(await (await call("/v8/artifacts/status?slug=team")).json(), { status: "enabled" });
});

test("a log-only upload is kept in the sandbox directory, re-written, and served back with its duration", async () => {
    const hash = "1111111111111111";
    assert.equal((await call(`/v8/artifacts/${hash}`)).status, 404);
    const upload = await put(`/v8/artifacts/${hash}?slug=team`, logOnly(), { headers: { "x-artifact-duration": "1234" } });
    assert.equal(upload.status, 200);
    assert.equal(existsSync(join(sandboxDir, `${hash}.tar.zst`)), true);
    assert.equal(existsSync(join(ciDir, `${hash}.tar.zst`)), false);
    assert.equal(JSON.parse(readFileSync(join(sandboxDir, `${hash}-meta.json`), "utf8")).duration, 1234);
    const head = await call(`/v8/artifacts/${hash}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    const got = await call(`/v8/artifacts/${hash}`);
    assert.equal(got.headers.get("x-artifact-duration"), "1234");
    const entries = readTar(zstdDecompressSync(Buffer.from(await got.arrayBuffer())));
    assert.deepEqual(
        entries.map((entry) => [entry.path, entry.data.toString()]),
        [[LOG, "typechecked\n"]],
    );
});

test("a build's upload is refused and leaves nothing behind", async () => {
    const hash = "2222222222222222";
    const build = zstdCompressSync(
        writeTar([
            { path: "packages/a/.turbo/turbo-build.log", data: Buffer.from("built") },
            { path: "packages/a/dist/index.js", data: Buffer.from("evil()") },
        ]),
    );
    const upload = await put(`/v8/artifacts/${hash}`, build);
    assert.equal(upload.status, 403);
    assert.match((await upload.json()).message, /dist\/index\.js/);
    assert.equal(readdirSync(sandboxDir).filter((name) => name.startsWith(hash)).length, 0);
});

test("CI's entry is served first and never replaced by an upload", async () => {
    const hash = "3333333333333333";
    writeEntry(ciDir, hash, logOnly("from ci\n"), 10);
    const upload = await put(`/v8/artifacts/${hash}`, logOnly("from a sandbox\n"));
    assert.equal(upload.status, 200);
    assert.equal(existsSync(join(sandboxDir, `${hash}.tar.zst`)), false);
    const served = readTar(zstdDecompressSync(Buffer.from(await (await call(`/v8/artifacts/${hash}`)).arrayBuffer())));
    assert.equal(served[0].data.toString(), "from ci\n");
});

test("what is not a task hash, or too big to be a log, is turned away", async () => {
    assert.equal((await call("/v8/artifacts/..%2F..%2Fetc%2Fpasswd")).status, 400);
    assert.equal((await call("/v8/artifacts/XYZ")).status, 400);
    const big = await put("/v8/artifacts/4444444444444444", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    assert.equal(big.status, 413);
    assert.equal((await post("/v8/artifacts/events", "[]")).status, 200);
});
