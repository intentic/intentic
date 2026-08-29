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

/* THE LOOPBACK LISTENER'S PROTOCOL: pinned here because getting it wrong does not fail, it FREEZES the app.
 *
 * A browser allows six concurrent HTTP/1.1 connections per origin, and this app holds long-lived ones: `/events`
 * for the life of the tab, plus an `/agent/attach` per conversation with a live turn. Four or five running
 * agents used to consume every slot, after which the next ordinary read simply queued in the browser until a
 * stream ended: a workspace that looks frozen while the daemon's log stays silent and healthy, because the
 * requests never reached it. h2 multiplexes them onto one connection instead.
 *
 * These assertions are exactly the three ways main.ts's serve() options can regress: dropping back to
 * node:https (no h2), losing `allowHTTP1` (no terminals), or a node-server upgrade that stops emitting
 * `upgrade` on an http2 server. Each is silent until someone has five agents running. */

const dir = mkdtempSync(join(tmpdir(), "h2-"));
// A throwaway self-signed pair: h2 in browsers (and in node's client) exists only over TLS. openssl is already
// a test dependency here; csr.integration.test.ts shells out to it the same way.
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
// Shaped like the streams that starve the pool: frames trickling out over time rather than one prompt body.
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

// The real thing, not a reconstruction of its options: this is what main.ts builds, so a regression in the
// module is a failure here rather than a test that keeps passing about a shape nobody uses any more.
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

// Read one response body off an h2 stream, counting the SSE frames it delivered.
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
    // Twelve is comfortably past the cap that was freezing the workspace; on HTTP/1.1 the last six could not
    // even start until the first six finished, which is the starvation this exists to prevent.
    const counts = await Promise.all(Array.from({ length: 12 }, () => frames("/stream")));
    expect(counts).toEqual(Array.from({ length: 12 }, () => 3));
});

test("a WebSocket still upgrades, over the http/1.1 connection allowHTTP1 keeps accepting", async () => {
    // Terminals have no h2 form here (node does not advertise the extended-CONNECT setting RFC 8441 needs), so
    // the browser opens a separate http/1.1 connection for them. Without allowHTTP1 that connection is refused
    // and every terminal in the product stops opening.
    const socket = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    const echoed = await new Promise<string>((resolve) => {
        socket.on("open", () => socket.send("hello"));
        socket.on("message", (data) => resolve(String(data)));
        socket.on("error", (error: Error) => resolve(`error: ${error.message}`));
    });
    socket.close();
    expect(echoed).toBe("echo:hello");
});

/* THE SAME PORT ALSO ANSWERS PLAIN HTTP, and that is the half that survives the internet going away.
 *
 * The TLS side above is reachable only as `local-<id>.<zone>`, a PUBLIC name: the browser has to resolve it
 * before it can use any of it. This one is reachable as `http://127.0.0.1:<port>` and needs no name at all,
 * which is why it is the candidate that still works when the owner's connection drops, when public DNS is
 * unreachable, or when the zone's record has gone missing. Serving TLS *instead of* it once a certificate
 * arrived is what used to leave a sandbox on the same machine unreachable during an outage. */
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
    expect(bare.tls).toBe(false);
    const response = await fetch(`http://127.0.0.1:${barePort}/ping`);
    expect(await response.text()).toBe("pong");
    bare.close();
});
