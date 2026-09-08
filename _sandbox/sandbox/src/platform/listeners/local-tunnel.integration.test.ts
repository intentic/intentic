import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterAll, expect, it } from "vitest";
import { startPlatformTunnel } from "./local-tunnel.js";

// Reproduces a dev platform's certificate-name mismatch: the bundled translator opens the connection itself and fails
// TLS verification. Integration, not unit, since the claim is about a real handshake.

const dir = mkdtempSync(join(tmpdir(), "tunnel-"));
// Cut for `localhost`, reached on `127.0.0.1`: the same mismatch shape a dev platform hands a sandbox addressing it as
// `host.docker.internal`.
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
    // Baseline: without the tunnel, a verifying client cannot reach this platform at all.
    await expect(fetch(`${platformUrl}/trial/status`)).rejects.toThrow();

    const tunnel = startPlatformTunnel(platformUrl, logger);
    await expect.poll(() => tunnel.url(), { timeout: 5_000 }).toBeDefined();

    const response = await fetch(`${tunnel.url()}/trial/v1/models`);

    expect(response.status).toBe(200);
    // Proves the tunnel rewrites nothing: path, method and body pass through untouched.
    expect(await response.json()).toEqual({ path: `/trial/v1/models` });
    tunnel.close();
});

it("opens nothing for a deployed platform, which needs no help", () => {
    expect(startPlatformTunnel(`https://app.intentic.dev`, logger).url()).toBeUndefined();
    // Also true for no platform configured at all, and for one already on plain http.
    expect(startPlatformTunnel(``, logger).url()).toBeUndefined();
    expect(startPlatformTunnel(`http://localhost:6480`, logger).url()).toBeUndefined();
});
