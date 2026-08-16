import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterAll, expect, it } from "vitest";
import { startPlatformTunnel } from "./local-tunnel.js";

/* THE FAILURE THIS EXISTS FOR, REPRODUCED: a platform on the developer's own machine, serving a certificate cut
 * for a name that is not the one the sandbox reaches it on. The bundled translator opens the trial's connection
 * itself, verifies, fails, and answers 500 — which the harness reads as an outage and rides its retry budget,
 * so the reader is told "The model provider is not responding" about a certificate.
 *
 * Pinned as an integration test rather than a unit one because the whole claim is about a real TLS handshake:
 * that a strict client which CANNOT be reached by any of this daemon's fetch wrappers still gets through.
 */

const dir = mkdtempSync(join(tmpdir(), "tunnel-"));
// Cut for `localhost` and reached on `127.0.0.1` — the same shape of mismatch a dev platform hands a sandbox
// that has to address it as `host.docker.internal`. openssl is already a test dependency here.
execFileSync(
    "openssl",
    [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
    ],
    { stdio: "ignore" },
);

const platform = createServer({ cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) }, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
});
await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
const platformUrl = `https://127.0.0.1:${(platform.address() as AddressInfo).port}`;

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

afterAll(() => platform.close());

it("carries a strict client past a dev platform's own certificate", async () => {
    // The state of the world without it: a client that verifies — which is every client we do not own — cannot
    // talk to this platform at all, and says so in a sentence about certificates.
    await expect(fetch(`${platformUrl}/trial/status`)).rejects.toThrow();

    const tunnel = startPlatformTunnel(platformUrl, logger);
    await expect.poll(() => tunnel.url(), { timeout: 5_000 }).toBeDefined();

    const response = await fetch(`${tunnel.url()}/trial/v1/models`);

    expect(response.status).toBe(200);
    // Transparent: the path, the method and the body are the platform's own — nothing here rewrites a request,
    // which is what lets a streamed completion stream through it.
    expect(await response.json()).toEqual({ path: `/trial/v1/models` });
    tunnel.close();
});

it("opens nothing for a deployed platform, which needs no help", () => {
    expect(startPlatformTunnel(`https://app.intentic.dev`, logger).url()).toBeUndefined();
    // Nor for a daemon with no platform at all (a loopback or test run), nor for one already on plain http.
    expect(startPlatformTunnel(``, logger).url()).toBeUndefined();
    expect(startPlatformTunnel(`http://localhost:6480`, logger).url()).toBeUndefined();
});
