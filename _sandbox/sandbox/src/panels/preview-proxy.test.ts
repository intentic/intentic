import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PanelUpstream, PanelUpstreamResolver } from "./panel-upstream.js";
import { createPreviewProxy, PREVIEW_PROBE_PATH, type SlotResolver } from "./preview-proxy.js";

const servers: (http.Server | https.Server)[] = [];
afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

const listen = async (server: http.Server | https.Server): Promise<number> => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
};

const noSlots: SlotResolver = () => undefined;
// A panel resolver over a fixed table: anything not in it is a repo with nothing running.
const panelsOf =
    (table: Record<string, PanelUpstream>): PanelUpstreamResolver =>
    (key) =>
        Promise.resolve(table[key] ?? { state: "stopped" });
const noPanels: PanelUpstreamResolver = panelsOf({});

// One upstream panel echoing which Host it saw; the proxy resolves "app" to it and everything else to nothing.
const setup = async (slots?: (appPort: number) => SlotResolver): Promise<{ proxyPort: number; appPort: number }> => {
    const appPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`hello from ${req.headers.host ?? "?"}${req.url ?? ""}`);
        }),
    );
    const panelOf = panelsOf({ app: { state: "serving", port: appPort, assigned: true } });
    const proxyPort = await listen(createPreviewProxy({ panelOf, slotTargetOf: slots === undefined ? noSlots : slots(appPort) }));
    return { proxyPort, appPort };
};

// The same call keeping the response headers, for the probe (whose CORS header IS the thing under test).
const raw = (proxyPort: number, host: string, path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: proxyPort, path, headers: { host } }, (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
        });
        request.on("error", reject);
        request.end();
    });

// fetch (undici) refuses to override the Host header, so drive the proxy with a raw http.request.
const get = (proxyPort: number, host: string, path = "/", extra: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: proxyPort, path, headers: { host, ...extra } }, (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        request.on("error", reject);
        request.end();
    });

test("strips the preview- prefix off the Host's first label to route, forwarding Host + path unchanged", async () => {
    const { proxyPort } = await setup();
    const response = await get(proxyPort, "preview-app.example.com", "/about?x=1");
    expect(response.status).toBe(200);
    expect(response.body).toBe("hello from preview-app.example.com/about?x=1");
});

test("a Host without a preview-/port- prefix (a stray *.<zone> subdomain) is a 404", async () => {
    const { proxyPort } = await setup();
    const response = await get(proxyPort, "app.example.com");
    expect(response.status).toBe(404);
});

test("a repo whose panel isn't running is a 502 pointing at the sidebar", async () => {
    const { proxyPort } = await setup();
    const response = await get(proxyPort, "preview-desired-state.example.com");
    expect(response.status).toBe(502);
    expect(response.body).toContain(`panel "desired-state" is not running`);
});

// Forwarded-port slots: `port-<slot>` routes through the slot table, and (unlike panels) Host and Origin are
// rewritten to localhost:<port>, because arbitrary dev servers' host checks only allow localhost.
test("a port- host resolves through the slot table and rewrites Host to localhost:<port>", async () => {
    const { proxyPort, appPort } = await setup((port) => (slot) => (slot === "a" ? { port, host: "127.0.0.1", scheme: "http" } : undefined));
    const response = await get(proxyPort, "port-a.example.com", "/page");
    expect(response.status).toBe(200);
    expect(response.body).toBe(`hello from localhost:${appPort}/page`);
});

// The field failure behind this test: Vite binds `localhost`, which can land on IPv6 loopback ONLY, a
// 127.0.0.1 dial gets connection-refused. The forward table records the dialable host; the proxy must honor it.
test("a ::1-only upstream (a `localhost`-bound dev server) is dialed at ::1, not 127.0.0.1", async () => {
    const v6Server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`v6 hello from ${req.headers.host ?? "?"}`);
    });
    servers.push(v6Server);
    await new Promise<void>((resolve) => v6Server.listen(0, "::1", resolve));
    const v6Port = (v6Server.address() as AddressInfo).port;
    const proxyPort = await listen(
        createPreviewProxy({
            panelOf: noPanels,
            slotTargetOf: (slot) => (slot === "a" ? { port: v6Port, host: "::1", scheme: "http" } : undefined),
        }),
    );
    const response = await get(proxyPort, "port-a.example.com");
    expect(response.status).toBe(200);
    expect(response.body).toBe(`v6 hello from localhost:${v6Port}`);
});

test("an unmapped slot is a 502, not a 404: the hostname is ours, the forward just lapsed", async () => {
    const { proxyPort } = await setup((port) => (slot) => (slot === "a" ? { port, host: "127.0.0.1", scheme: "http" } : undefined));
    const response = await get(proxyPort, "port-b.example.com");
    expect(response.status).toBe(502);
    expect(response.body).toContain("nothing is forwarded here");
});

test("a port target rewrites Origin alongside Host", async () => {
    const echoPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`origin=${req.headers.origin ?? "?"}`);
        }),
    );
    const proxyPort = await listen(
        createPreviewProxy({
            panelOf: noPanels,
            slotTargetOf: (slot) => (slot === "a" ? { port: echoPort, host: "127.0.0.1", scheme: "http" } : undefined),
        }),
    );
    const response = await get(proxyPort, "port-a.example.com", "/", { origin: "https://port-a.example.com" });
    expect(response.body).toBe(`origin=http://localhost:${echoPort}`);
});

// The vite in a scaffolded app serves https with a self-signed cert on its random port: the proxy must dial
// TLS (verification off) when the forward probe detected https. Static throwaway cert, generated for this test.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCY2dCWIBg49fK7
gXa5sGPU0Fj2oHrznWU9wNKjGnWrts/wl9qSrvbBGQ29wcB0lAvRo06/Ikdw7MY2
OVaPh3l9gQAEFb/TqAUPCbY5hg1oNHZddwZadpKdVaIZvrd6hY2YRRIOhBPy8awV
/FYwjp39SJVVTJ3DcygmlrLPZaRxxhr+ix2rircSAYIlpH/zxyNoJv71p99SlxVQ
eYEqeCPx78avBC2URsfh8XAXgym0Lub18n10JRQSl9LYJ6gUA3peqzcSOQMrUvF5
erQVnL7lan+b8pu8818sYw15Bbau6iF2F9ZFFgYnHSN38ydRk5mhHXyDamlSVeBn
1+EgygnzAgMBAAECggEAS6rch005II2lDez/1Nn8+d/wgpsccthyw5jeza6uHQUh
uJW8NwxVjG82Lb+qYiveE/hX5ef23PDiCPrmnqQu4RII63zG22Vcp76jjqONpI4A
ILHpG8SCPVAksMEIvKc72usqjrQU2hqImdOy6VPY44fYoYMNwLGT6VKGD4TeXRG0
kKZEtUE2rU0vo3vxikTh+nevXTGo7dpdiCFP+PL8giuvTrItBrNmpCW3zKouidPc
Z1Pv1klNjjpjvM4B87BuCNb0lk3MxtZLwyMfyYs/KmjKuW1BK2k/TFr1YrKt1T0m
B/C3m5SocNGgrYWDEIOWGMVIcCm73Y8WzsQ179fH3QKBgQDSyL3fGov0rCXsI0C+
RN21tL7IFLNtDUYTaG6F3bx0ucq0NfVH6tETZJBwSYUclOoHTgvd88THZpx7nGOL
vpScI+adJw/ZXBsdR1sVP6yS0Nv+59mvzcyFO73Xz/0Mv0sW0gKZp9DZDue/qSZh
1kwHN1zfbENUaDFvEpaSs3abDwKBgQC5o6cREJhnCzsbSe73jg9MNc114/D4Ndk0
axuQIYU3N5tSTBn1Qj8wmeyl8WnjGLVxk3Qa2aNP4AptjPRyXCEUlALd6wgPutP9
5PhALaFrAcX4DTnrZXTwfJmAf3IaLVWHvQwHLDD41MJB76Gf7QSdcgHH4b5WUFqo
CjwUxg7y3QKBgBUR2eDuT2UivBuxnmwmiB78tUFcyF6zP/j6rGmXM5pbZAbFigIp
V8Lff4yp3LNxsz8NryP9lQL1n9i/VjgG0eYVtJyq5eutSEyR8GncVozKceM2G811
/eanhR+Ie9wFVyUt0vK3EqpP0hyXdO28tRbXkuIGeWh7jc1zhzec1tNDAoGANqnL
7ih22BDkjLqOlXLNamGFaKuAL3abyOWpLh3QvluvbuJd2mxxcvxARPT7exWxiAol
bCqd/k04hN22tV4Pl6Gl3nbw3sDi36Zmu280UvAovUwXvAsaDh6CjOX6UV78CoZO
XmZS3VK5CPVpIFCIxVvmzlbY102+BDFPU8ambDkCgYBRSA1tBknQ2LI7RMMpqqSP
BxCIrbjhMbCegBoBE7rbae4EkLTAJdF1QHYGSfAlHWloxiMX153J9PggMgSaUE6i
0n21WYK5y2as6cgwYpYgWG2mccFY5NwWOSQEYWKGQ7E/TgytNEHbfnK2PC7jjSN0
6wKi2DkUyuIlaaY+EEsh4g==
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUcvnOP2h7U6s/evv3jc2H04guKIMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcxOTE1MTUyNloYDzIxMjYw
NjI1MTUxNTI2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCY2dCWIBg49fK7gXa5sGPU0Fj2oHrznWU9wNKjGnWr
ts/wl9qSrvbBGQ29wcB0lAvRo06/Ikdw7MY2OVaPh3l9gQAEFb/TqAUPCbY5hg1o
NHZddwZadpKdVaIZvrd6hY2YRRIOhBPy8awV/FYwjp39SJVVTJ3DcygmlrLPZaRx
xhr+ix2rircSAYIlpH/zxyNoJv71p99SlxVQeYEqeCPx78avBC2URsfh8XAXgym0
Lub18n10JRQSl9LYJ6gUA3peqzcSOQMrUvF5erQVnL7lan+b8pu8818sYw15Bbau
6iF2F9ZFFgYnHSN38ydRk5mhHXyDamlSVeBn1+EgygnzAgMBAAGjUzBRMB0GA1Ud
DgQWBBTluGNlisCGSYsrJjNVW9apHnyCKjAfBgNVHSMEGDAWgBTluGNlisCGSYsr
JjNVW9apHnyCKjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAV
iUueYhssl/gfLtSe/D8xXR9owh/w7t4hjHp1wik7foR05I5ac6JP8Ga8AotKAMeg
T61gqpTvI/XJITDROkbfzLBEDJhNc+oXdkEDX+zsI46XKOP5+WLrBnYIH5l00ERF
f66TnKyv/PEL7F46ztqYvP95W2lPeCbaC+uEX6iY4Ou12fru1XFZP2oCNFeJGKXN
bdxRwgZCGP3bG5ur5Ohc0Nqs7/0wLhJlE4po/4XQVqFPc8VwPr87nuFKrX3ZrRpm
5rmqM3nJ9Kh07fsEHL/Fak5GI3NOwcoSnO4HM0Bb0N9Ka/I3zJgpjFWpO3+oTP7K
V8t6jTC2x6if7DRrtmpO
-----END CERTIFICATE-----`;

test("an https-scheme slot target is dialed over TLS with verification off (self-signed dev certs)", async () => {
    const tlsPort = await listen(
        https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`secure hello from ${req.headers.host ?? "?"}`);
        }),
    );
    const target: PortTarget = { port: tlsPort, host: "127.0.0.1", scheme: "https" };
    const proxyPort = await listen(createPreviewProxy({ panelOf: noPanels, slotTargetOf: (slot) => (slot === "a" ? target : undefined) }));
    const response = await get(proxyPort, "port-a.example.com");
    expect(response.status).toBe(200);
    expect(response.body).toBe(`secure hello from localhost:${tlsPort}`);
});

// A proxy configured with the sandbox id: hosts must carry the exact `-<id>` suffix (the shared-zone scheme:
// see hostnames.ts); the suffix is stripped before the lookup and (for panels) Host is forwarded unchanged.
const ID = "abc123def456";
const idSetup = async (): Promise<{ proxyPort: number; appPort: number }> => {
    const appPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`hello from ${req.headers.host ?? "?"}`);
        }),
    );
    const panelOf = panelsOf({ app: { state: "serving", port: appPort, assigned: true } });
    const slotTargetOf: SlotResolver = (slot) => (slot === "a" ? { port: appPort, host: "127.0.0.1", scheme: "http" } : undefined);
    return { proxyPort: await listen(createPreviewProxy({ panelOf, slotTargetOf, sandboxId: ID })), appPort };
};

test("with a sandbox id, the -<id> suffix is stripped to route and Host is forwarded unchanged", async () => {
    const { proxyPort } = await idSetup();
    const response = await get(proxyPort, `preview-app-${ID}.example.com`);
    expect(response.status).toBe(200);
    expect(response.body).toBe(`hello from preview-app-${ID}.example.com`);
});

test("with a sandbox id, a bare or wrong-id preview/port host is a 404, not another sandbox's upstream", async () => {
    const { proxyPort } = await idSetup();
    expect((await get(proxyPort, "preview-app.example.com")).status).toBe(404);
    expect((await get(proxyPort, "preview-app-000000000000.example.com")).status).toBe(404);
    expect((await get(proxyPort, "port-a.example.com")).status).toBe(404);
    expect((await get(proxyPort, "port-a-000000000000.example.com")).status).toBe(404);
});

test("with a sandbox id, a port slot host routes and rewrites like the id-less form", async () => {
    const { proxyPort, appPort } = await idSetup();
    const response = await get(proxyPort, `port-a-${ID}.example.com`);
    expect(response.status).toBe(200);
    expect(response.body).toBe(`hello from localhost:${appPort}`);
});

/* --- What the hostname resolves to, when it isn't simply "the assigned port" -----------------------------
 * The proxy routes on what the repo is SERVING (panel-upstream.ts owns that rule); these are the three
 * answers that are not a plain forward, and each has a page a person can act on. */

test("a panel serving on a port it pinned itself is dialed there, with Host rewritten to localhost", async () => {
    const appPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`hello from ${req.headers.host ?? "?"}`);
        }),
    );
    // `assigned: false` ⇒ nothing agreed to answer at the preview hostname, so the app's own host check
    // (vite/webpack allow localhost and nothing else) must see localhost, exactly as a forwarded port does.
    const panelOf = panelsOf({ app: { state: "serving", port: appPort, assigned: false } });
    const proxyPort = await listen(createPreviewProxy({ panelOf, slotTargetOf: noSlots }));
    const response = await get(proxyPort, "preview-app.example.com");
    expect(response.status).toBe(200);
    expect(response.body).toBe(`hello from localhost:${appPort}`);
});

test("a panel whose dev servers each pinned their own port is a 502 that names them", async () => {
    const panelOf = panelsOf({
        mono: {
            state: "several",
            servers: [
                { port: 4321, dir: "_site/site" },
                { port: 47145, dir: "_editor/web" },
            ],
        },
    });
    const proxyPort = await listen(createPreviewProxy({ panelOf, slotTargetOf: noSlots }));
    const response = await get(proxyPort, "preview-mono.example.com");
    expect(response.status).toBe(502);
    expect(response.body).toContain("_site/site:4321");
    expect(response.body).toContain("_editor/web:47145");
});

test("a panel the daemon runs that hasn't opened a port yet reads as starting, not as missing", async () => {
    const proxyPort = await listen(createPreviewProxy({ panelOf: panelsOf({ app: { state: "starting" } }), slotTargetOf: noSlots }));
    const response = await get(proxyPort, "preview-app.example.com");
    expect(response.status).toBe(502);
    expect(response.body).toContain("hasn't opened a port yet");
});

/* --- The probe, which is how a BROWSER can tell "this name doesn't reach the sandbox" from "it does, and the
 * server is down". Cross-origin it can read nothing else: a no-cors fetch settles on any answer, including the
 * edge's 502 for an unrouted name, which is what used to get framed. */

test("the probe path answers with CORS open and the panel's live state, without touching the upstream", async () => {
    const { proxyPort, appPort } = await setup();
    const response = await raw(proxyPort, "preview-app.example.com", PREVIEW_PROBE_PATH);
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(response.body)).toEqual({ proxy: "intentic-preview", target: "panel", name: "app", state: "serving" });
    // The upstream never saw it: it echoes its own greeting for anything it does receive.
    expect(response.body).not.toContain(`${appPort}`);
});

test("the probe reports a panel that isn't running, and the ports it is really serving when several", async () => {
    const panelOf = panelsOf({ mono: { state: "several", servers: [{ port: 4321, dir: "_site/site" }] } });
    const proxyPort = await listen(createPreviewProxy({ panelOf, slotTargetOf: noSlots }));
    expect(JSON.parse((await raw(proxyPort, "preview-idle.example.com", PREVIEW_PROBE_PATH)).body)).toMatchObject({ state: "stopped" });
    expect(JSON.parse((await raw(proxyPort, "preview-mono.example.com", PREVIEW_PROBE_PATH)).body)).toMatchObject({
        state: "several",
        servers: [{ port: 4321, dir: "_site/site" }],
    });
});

test("the probe on a stray subdomain is a 404: only a name this sandbox serves may claim to be a preview", async () => {
    const { proxyPort } = await setup();
    const response = await raw(proxyPort, "app.example.com", PREVIEW_PROBE_PATH);
    expect(response.status).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
});

test("the probe answers for an unforwarded slot too, which is a live address with nothing behind it", async () => {
    const { proxyPort } = await setup((port) => (slot) => (slot === "a" ? { port, host: "127.0.0.1", scheme: "http" } : undefined));
    expect(JSON.parse((await raw(proxyPort, "port-a.example.com", PREVIEW_PROBE_PATH)).body)).toEqual({
        proxy: "intentic-preview",
        target: "port",
        state: "serving",
    });
    expect(JSON.parse((await raw(proxyPort, "port-b.example.com", PREVIEW_PROBE_PATH)).body)).toEqual({
        proxy: "intentic-preview",
        target: "port",
        state: "unforwarded",
    });
});

/* THE DAEMON'S OWN ADDRESS, which is not a preview and arrives here anyway.
 *
 * The edge carries every hostname this sandbox answers to down ONE tunnel, and that tunnel forwards to ONE
 * port, so this proxy is the container's front door: it is what tells `sandbox-<id>` apart from a preview. The
 * fabrics before this one held a rule per hostname and could route the daemon's address to a different port
 * out there; one tunnel cannot, so the dispatch moved in here. */
test("the sandbox's own hostname reaches the daemon, with its Host intact", async () => {
    const daemonPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`daemon saw ${req.headers.host ?? "?"}${req.url ?? ""}`);
        }),
    );
    const proxyPort = await listen(createPreviewProxy({ panelOf: noPanels, slotTargetOf: noSlots, sandboxId: "abcdef012345", daemonPort }));

    const response = await raw(proxyPort, "sandbox-abcdef012345.sbx.example.test", "/health");

    expect(response.status).toBe(200);
    // Host passes through untouched, unlike a panel's: the daemon derives its own origin from it and gates on it.
    expect(response.body).toBe("daemon saw sandbox-abcdef012345.sbx.example.test/health");
});

test("another sandbox's daemon hostname is not this sandbox's to serve", async () => {
    const daemonPort = await listen(http.createServer((_req, res) => res.end("daemon")));
    const proxyPort = await listen(createPreviewProxy({ panelOf: noPanels, slotTargetOf: noSlots, sandboxId: "abcdef012345", daemonPort }));

    expect((await raw(proxyPort, "sandbox-0123456789ab.sbx.example.test", "/health")).status).toBe(404);
});

// The loopback lanes pass no daemon port: the browser reaches that port directly there, and this proxy only
// ever sees previews.
test("with no daemon port there is no daemon route", async () => {
    const proxyPort = await listen(createPreviewProxy({ panelOf: noPanels, slotTargetOf: noSlots, sandboxId: "abcdef012345" }));

    expect((await raw(proxyPort, "sandbox-abcdef012345.sbx.example.test", "/health")).status).toBe(404);
});
