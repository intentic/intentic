import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { LEAF_CRT, LEAF_KEY } from "@intentic-app/localhost-https/paths";
import { expect, test } from "vitest";
import { answers, cachedScheme, detectScheme } from "./port-probe.js";

/* Against real sockets, because the bug this replaced was entirely about what a real socket does: the old probe
 * was `fetch("http://127.0.0.1:<port>/")`, which a TLS listener refuses at the socket and which rejects a
 * self-signed cert even when asked in https, so a Vite dev server serving the repo's own dev cert read as
 * DOWN and its panel span "Starting…" for as long as it ran. The cert below is that same one.
 *
 * Minted rather than read straight off disk: the pair lives in this user's data directory rather than the repo,
 * so a fresh worktree or a CI runner has none until something asks for one. The generator is idempotent and
 * returns immediately when the pair is already there. */
const GENERATOR = join(repoRoot(import.meta.url), "_tools", "localhost-https", "generate.mjs");
execFileSync("node", [GENERATOR], { stdio: "ignore" });
const tls = { cert: readFileSync(LEAF_CRT), key: readFileSync(LEAF_KEY) };

// Listen on an OS-assigned port and hand it back, closing the server when the test ends.
const serve = async (server: http.Server | net.Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
};

test("a plaintext dev server is detected as http", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    expect(await detectScheme(port)).toBe("http");
    server.close();
});

test("a dev server on the repo's own self-signed cert is detected as https, not as down", async () => {
    const server = https.createServer(tls, (_request, response) => response.end("ok"));
    const port = await serve(server);
    expect(await detectScheme(port)).toBe("https");
    // The half that made it a bug: asked in the wrong language, a TLS listener denies it is there at all.
    expect(await answers("http", port)).toBe(false);
    server.close();
});

test("any status counts as answering: a watch server is up before it has routes", async () => {
    const server = http.createServer((_request, response) => {
        response.statusCode = 404;
        response.end();
    });
    const port = await serve(server);
    expect(await answers("http", port)).toBe(true);
    server.close();
});

test("nothing listening is undefined rather than a default scheme", async () => {
    // Bind and release: the port is real and free, so the dial is refused rather than left hanging.
    const idle = net.createServer();
    const port = await serve(idle);
    await new Promise<void>((resolve) => idle.close(() => resolve()));
    expect(await detectScheme(port)).toBeUndefined();
});

test("a socket that accepts and never answers times out instead of hanging the panel list", async () => {
    const silent = net.createServer(() => {
        // Accept the connection and say nothing at all: neither HTTP nor TLS ever completes.
    });
    const port = await serve(silent);
    expect(await detectScheme(port)).toBeUndefined();
    silent.close();
});

/* The polled/gesture split, asserted from both sides in one test because it is the whole point of there being
 * two functions: a route the browser refetches every few seconds may reuse an answer, and the forward gesture,
 * which re-probes precisely because a server restarted on the same port may have flipped scheme, may not. */
test("cachedScheme reuses an answer where detectScheme still goes and looks", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    expect(await cachedScheme(port)).toBe("http");
    // Closed, so any fresh dial is refused: an answer after this can only have come from the cache.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await cachedScheme(port)).toBe("http");
    expect(await detectScheme(port)).toBeUndefined();
});

// The half that matters more than either TTL: one render asks about the same port from several components, and
// without sharing each opens its own socket and waits out its own timeout.
test("concurrent reads of one port share a single probe rather than dialing once each", async () => {
    let connections = 0;
    const server = http.createServer((_request, response) => response.end("ok"));
    server.on("connection", () => {
        connections += 1;
    });
    const port = await serve(server);
    expect(await Promise.all([cachedScheme(port), cachedScheme(port), cachedScheme(port)])).toEqual(["http", "http", "http"]);
    expect(connections).toBe(1);
    server.close();
});
