import http from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, expect, test } from "vitest";
import { createPreviewProxy, type PortResolver } from "./preview-proxy.js";

const servers: http.Server[] = [];
afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

const listen = async (server: http.Server): Promise<number> => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
};

// One upstream panel echoing which Host it saw; the proxy resolves "app" to it and everything else to nothing.
const setup = async (): Promise<{ proxyPort: number }> => {
    const appPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`hello from ${req.headers.host ?? "?"}${req.url ?? ""}`);
        }),
    );
    const portOf: PortResolver = (repo) => (repo === "app" ? appPort : undefined);
    const proxyPort = await listen(createPreviewProxy(portOf));
    return { proxyPort };
};

// fetch (undici) refuses to override the Host header, so drive the proxy with a raw http.request.
const get = (proxyPort: number, host: string, path = "/"): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: proxyPort, path, headers: { host } }, (response) => {
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

test("a Host without the preview- prefix (a stray *.<zone> subdomain) is a 404", async () => {
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

// A proxy configured with the sandbox id: hosts must carry the exact `-<id>` suffix (the shared-zone scheme —
// see preview-hostname.ts); the suffix is stripped before the port lookup and Host is forwarded unchanged.
const ID = "abc123def456";
const idSetup = async (): Promise<{ proxyPort: number }> => {
    const appPort = await listen(
        http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`hello from ${req.headers.host ?? "?"}`);
        }),
    );
    const portOf: PortResolver = (repo) => (repo === "app" ? appPort : undefined);
    return { proxyPort: await listen(createPreviewProxy(portOf, ID)) };
};

test("with a sandbox id, the -<id> suffix is stripped to route and Host is forwarded unchanged", async () => {
    const { proxyPort } = await idSetup();
    const response = await get(proxyPort, `preview-app-${ID}.example.com`);
    expect(response.status).toBe(200);
    expect(response.body).toBe(`hello from preview-app-${ID}.example.com`);
});

test("with a sandbox id, a bare or wrong-id preview host is a 404, not another sandbox's panel", async () => {
    const { proxyPort } = await idSetup();
    expect((await get(proxyPort, "preview-app.example.com")).status).toBe(404);
    expect((await get(proxyPort, "preview-app-000000000000.example.com")).status).toBe(404);
});
