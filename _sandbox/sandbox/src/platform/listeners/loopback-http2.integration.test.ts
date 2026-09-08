import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeWebSocket, type WebSocketServerLike } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createLoopbackListener } from "./loopback-listener.js";

// Pins the loopback listener's h2 negotiation: getting it wrong doesn't error, it silently exhausts the browser's
// six-connections-per-origin limit and freezes the workspace.

const dir = mkdtempSync(join(tmpdir(), "h2-"));
// Throwaway self-signed pair: h2 in browsers only works over TLS; openssl is already a test dependency
// (csr.integration.test.ts).
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

const app = new Hono();
app.get("/ping", (c) => c.text("pong"));
// Shaped like the streams that starve the pool: frames trickling out over time, not one prompt body.
app.get("/stream", (c) =>
    c.body(
        new ReadableStream({
            start(controller) {
                let sent = 0;
                const timer = setInterval(() => {
                    sent += 1;
                    controller.enqueue(new TextEncoder().encode(`data: frame ${sent}\n\n`));
                    if (sent === 3) {
                        clearInterval(timer);
                        controller.close();
                    }
                }, 20);
            },
        }),
        200,
        { "content-type": "text/event-stream" },
    ),
);
app.get(
    "/ws",
    upgradeWebSocket(() => ({ onMessage: (event, ws) => ws.send(`echo:${String(event.data)}`) })),
);

// The real thing main.ts builds, not a reconstruction of its options, so a regression here is a real failure.
const server = createLoopbackListener({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
    sockets: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike,
    certificate: { certificate: readFileSync(join(dir, "cert.pem"), "utf8"), privateKey: readFileSync(join(dir, "key.pem"), "utf8") },
});
const port = await server.listening;
const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
await new Promise<void>((resolve, reject) => {
    session.once("connect", () => resolve());
    session.once("error", reject);
});

afterAll(() => {
    session.close();
    server.close();
});

// Reads one response body off an h2 stream, counting the SSE frames it delivered.
const frames = (path: string): Promise<number> =>
    new Promise((resolve) => {
        const request = session.request({ ":path": path });
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => resolve(body.split("data:").length - 1));
        request.on("error", () => resolve(-1));
        request.end();
    });

test("the loopback listener negotiates h2: the whole point of it being an http2 server", () => {
    expect(session.alpnProtocol).toBe("h2");
});

test("more concurrent long-lived streams than HTTP/1.1's six-per-origin, all on one connection", async () => {
    // Twelve is comfortably past HTTP/1.1's six-connection cap.
    const counts = await Promise.all(Array.from({ length: 12 }, () => frames("/stream")));
    expect(counts).toEqual(Array.from({ length: 12 }, () => 3));
});

test("a WebSocket still upgrades, over the http/1.1 connection allowHTTP1 keeps accepting", async () => {
    // Terminals have no h2 form (node doesn't advertise RFC 8441's extended CONNECT), so this rides a separate http/1.1
    // connection.
    const socket = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    const echoed = await new Promise<string>((resolve) => {
        socket.on("open", () => socket.send("hello"));
        socket.on("message", (data) => resolve(String(data)));
        socket.on("error", (error: Error) => resolve(`error: ${error.message}`));
    });
    socket.close();
    expect(echoed).toBe("echo:hello");
});

test("plain HTTP is served on the very same port, so the DNS-free candidate always has something to answer it", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(await response.text()).toBe("pong");
});

test("a listener with no certificate still serves plain HTTP, the state every sandbox boots into", async () => {
    const bare = createLoopbackListener({
        fetch: app.fetch,
        port: 0,
        hostname: "127.0.0.1",
        sockets: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike,
        certificate: undefined,
    });
    const barePort = await bare.listening;
    expect(bare.tls()).toBe(false);
    const response = await fetch(`http://127.0.0.1:${barePort}/ping`);
    expect(await response.text()).toBe("pong");
    bare.close();
});

test("a certificate handed over after boot is served without restarting the listener", async () => {
    const later = createLoopbackListener({
        fetch: app.fetch,
        port: 0,
        hostname: "127.0.0.1",
        sockets: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike,
        certificate: undefined,
    });
    const laterPort = await later.listening;
    expect(later.tls()).toBe(false);

    later.useCertificate({ certificate: readFileSync(join(dir, "cert.pem"), "utf8"), privateKey: readFileSync(join(dir, "key.pem"), "utf8") });
    expect(later.tls()).toBe(true);

    // h2 specifically, not just TLS: multiplexing is why the certified address is worth having.
    const handover = connect(`https://127.0.0.1:${laterPort}`, { rejectUnauthorized: false });
    const negotiated = await new Promise<string>((resolve) => {
        handover.once("connect", () => resolve("h2"));
        handover.once("error", (error: Error) => resolve(`error: ${error.message}`));
    });
    handover.close();
    expect(negotiated).toBe("h2");

    // The plain half must survive the handover too, not be traded away for h2.
    expect(await (await fetch(`http://127.0.0.1:${laterPort}/ping`)).text()).toBe("pong");
    later.close();
});
