import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { LEAF_CRT, LEAF_KEY } from "@intentic/localhost-https/paths";
import { expect, test } from "vitest";
import { answers, cachedScheme, detectScheme } from "./port-probe.js";

// Runs against real sockets: a TLS listener refuses a plaintext probe, and a self-signed cert needs the repo's real dev
// cert to read as up. The cert pair is minted into this user's data directory (idempotent) rather than committed.
const GENERATOR = join(repoRoot(import.meta.url), "_tools", "localhost-https", "generate.mjs");
execFileSync("node", [GENERATOR], { stdio: "ignore" });
const tls = { cert: readFileSync(LEAF_CRT), key: readFileSync(LEAF_KEY) };

// Listens on an OS-assigned port and returns it.
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
    // Asked in the wrong scheme, a TLS listener denies it's there at all.
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
    // Bind then release: the port is real but free, so the dial refuses instead of hanging.
    const idle = net.createServer();
    const port = await serve(idle);
    await new Promise<void>((resolve) => idle.close(() => resolve()));
    expect(await detectScheme(port)).toBeUndefined();
});

test("a socket that accepts and never answers times out instead of hanging the panel list", async () => {
    const silent = net.createServer(() => {
        // Accepts the connection and answers nothing; neither HTTP nor TLS ever completes.
    });
    const port = await serve(silent);
    expect(await detectScheme(port)).toBeUndefined();
    silent.close();
});

// cachedScheme may reuse a polled answer; detectScheme, used by the forward gesture, always re-probes since a restarted
// server may have flipped scheme.
test("cachedScheme reuses an answer where detectScheme still goes and looks", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await serve(server);
    expect(await cachedScheme(port)).toBe("http");
    // Closed: any fresh dial would refuse, so this answer can only be the cached one.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await cachedScheme(port)).toBe("http");
    expect(await detectScheme(port)).toBeUndefined();
});

// Matters more than the TTL: several components asking about one port in a render must share a probe, not each open its
// own socket.
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
