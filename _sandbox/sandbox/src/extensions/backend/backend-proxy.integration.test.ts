import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend } from "./backend-proxy.js";

// One request relayed to an extension backend on loopback: what reaches the backend, and what comes back from it.

let backend: Server;
let port: number;
let seen: IncomingHttpHeaders[];

beforeAll(async () => {
    seen = [];
    backend = createServer((request, response) => {
        seen.push(request.headers);
        if (request.url === "/x/zipped") {
            const zipped = gzipSync("plain words");
            response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": String(zipped.length) });
            response.end(zipped);
            return;
        }
        response.writeHead(200, { "content-type": "text/plain", connection: "x-backend-hop", "x-backend-hop": "1", "keep-alive": "timeout=5", "x-kept": "yes" });
        response.end("ok");
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe name.
    port = (backend.address() as AddressInfo).port;
});
afterAll(async () => {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
});

const app = (): Hono<AppEnv> => {
    const proxy = new Hono<AppEnv>();
    proxy.all("/x/*", (c) => forwardToBackend(c, { port, headers: { [BACKEND_HOST_HEADER]: "host-token" } }, new URL(c.req.url), "ext"));
    return proxy;
};

// Hop-by-hop headers describe the browser's connection to the daemon and the backend's to it, never the request; the
// caller's own credential stays behind too, and only the host token the daemon sets goes on.
test("hop-by-hop headers, any the Connection header names, and the caller's credential are not passed on", async () => {
    const response = await app().request("/x/page", {
        headers: {
            connection: "x-browser-hop",
            "x-browser-hop": "1",
            "proxy-authorization": "Basic cHJveHk6cGFzcw",
            te: "trailers",
            authorization: "Bearer daemon-session",
            "x-kept": "yes",
        },
    });
    expect(await response.text()).toBe("ok");
    const sent = seen.at(-1);
    expect(sent?.["x-browser-hop"]).toBeUndefined();
    expect(sent?.["proxy-authorization"]).toBeUndefined();
    expect(sent?.["te"]).toBeUndefined();
    expect(sent?.["authorization"]).toBeUndefined();
    expect(sent?.["x-kept"]).toBe("yes");
    expect(sent?.[BACKEND_HOST_HEADER]).toBe("host-token");
    expect(response.headers.has("x-backend-hop")).toBe(false);
    expect(response.headers.has("keep-alive")).toBe(false);
    expect(response.headers.get("x-kept")).toBe("yes");
});

// fetch hands back a gzip answer already decoded and frames the request body itself, so headers describing the bytes as
// they were on the wire would make the browser gunzip plain text, or read a body short.
test("an answer fetch decoded goes back without its encoding and length, and the caller's own framing stays behind", async () => {
    const response = await app().request("/x/zipped", { method: "POST", body: "sent", headers: { host: "sandbox.example", "accept-encoding": "br", "content-length": "4" } });
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toBe("plain words");
    const sent = seen.at(-1);
    expect(sent?.["host"]).toBe(`127.0.0.1:${port}`);
    expect(sent?.["accept-encoding"]).not.toBe("br");
});
