import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { answers, detectScheme } from "./port-probe.js";

/* Against real sockets, because the bug this replaced was entirely about what a real socket does: the old probe
 * was `fetch("http://127.0.0.1:<port>/")`, which a TLS listener refuses at the socket and which rejects a
 * self-signed cert even when asked in https — so a Vite dev server serving the repo's own dev cert read as
 * DOWN and its panel span "Starting…" for as long as it ran. The cert below is that same one.
 *
 * Minted rather than read straight off disk: the dev certificate is per machine and git-ignored, so a fresh
 * worktree has none until something asks for one. The generator is idempotent and returns immediately when
 * the pair is already there. */
const CERT_DIR = join(import.meta.dirname, "..", "..", "..", "..", "_tools", "localhost-https");
execFileSync("node", [join(CERT_DIR, "generate.mjs")], { stdio: "ignore" });
const tls = { cert: readFileSync(join(CERT_DIR, "localhost.crt")), key: readFileSync(join(CERT_DIR, "localhost.key")) };

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

test("any status counts as answering — a watch server is up before it has routes", async () => {
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
        // Accept the connection and say nothing at all — neither HTTP nor TLS ever completes.
    });
    const port = await serve(silent);
    expect(await detectScheme(port)).toBeUndefined();
    silent.close();
}, 10_000);
