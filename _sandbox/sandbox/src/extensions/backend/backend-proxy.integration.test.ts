import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { AppEnv } from "../../app-env.js";
import { BACKEND_CARD_HEADER, BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend } from "./backend-proxy.js";

// One request relayed to an extension backend on loopback: what reaches the backend, and what comes back from it.

let backend: Server;
let port: number;
let seen: IncomingHttpHeaders[];
let redirected: Server;
let redirectedUrl: string;
let redirectedSeen: IncomingHttpHeaders[];
let streamClosed: boolean;

beforeAll(async () => {
    seen = [];
    redirectedSeen = [];
    redirected = createServer((request, response) => {
        redirectedSeen.push(request.headers);
        response.end("redirect destination");
    });
    await new Promise<void>((resolve) => redirected.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: this server listens on TCP, so address() is an AddressInfo.
    redirectedUrl = `http://127.0.0.1:${(redirected.address() as AddressInfo).port}/destination`;
    backend = createServer((request, response) => {
        seen.push(request.headers);
        if (request.url === "/x/redirect") {
            response.writeHead(307, { location: redirectedUrl });
            response.end("follow in the caller");
            return;
        }
        if (request.url === "/x/stream") {
            streamClosed = false;
            response.on("close", () => {
                streamClosed = true;
            });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write("data: started\n\n");
            return;
        }
        if (request.url === "/x/zipped") {
            const zipped = gzipSync("plain words");
            response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip", "content-length": String(zipped.length) });
            response.end(zipped);
            return;
        }
        response.writeHead(200, {
            "content-type": "text/plain",
            connection: "x-backend-hop",
            "x-backend-hop": "1",
            "keep-alive": "timeout=5",
            "x-kept": "yes",
        });
        response.end("ok");
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe name.
    port = (backend.address() as AddressInfo).port;
});
afterAll(async () => {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await new Promise<void>((resolve) => redirected.close(() => resolve()));
});

const app = (): Hono<AppEnv> => {
    const proxy = new Hono<AppEnv>();
    proxy.all("/x/*", (c) =>
        forwardToBackend(
            c,
            { port, headers: { [BACKEND_HOST_HEADER]: "host-token", [BACKEND_CARD_HEADER]: "resolved-card-secret" } },
            new URL(c.req.url),
            "ext",
        ),
    );
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

test("a backend redirect is returned without sending host or resolved card credentials to its destination", async () => {
    const response = await app().request("/x/redirect");
    expect(redirectedSeen).toEqual([]);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(redirectedUrl);
    expect(await response.text()).toBe("follow in the caller");
});

test("abandoning a response after its headers closes the backend stream", async () => {
    const caller = new AbortController();
    const response = await app().request("/x/stream", { signal: caller.signal });
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new Error("the backend did not stream a body");
    }
    try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: started\n\n");
        caller.abort();
        await waitFor(() => expect(streamClosed).toBe(true), SETTLES);
    } finally {
        // allow(silent-catch): an aborted fetch body is already closed; cancellation is only cleanup on a failed assertion.
        await reader.cancel().catch(() => undefined);
    }
});

// fetch hands back a gzip answer already decoded and frames the request body itself, so headers describing the bytes as
// they were on the wire would make the browser gunzip plain text, or read a body short.
test("an answer fetch decoded goes back without its encoding and length, and the caller's own framing stays behind", async () => {
    const response = await app().request("/x/zipped", {
        method: "POST",
        body: "sent",
        headers: { host: "sandbox.example", "accept-encoding": "br", "content-length": "4" },
    });
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toBe("plain words");
    const sent = seen.at(-1);
    expect(sent?.["host"]).toBe(`127.0.0.1:${port}`);
    expect(sent?.["accept-encoding"]).not.toBe("br");
});
