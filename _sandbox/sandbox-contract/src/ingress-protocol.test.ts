import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, request as h1Request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Duplex, duplexPair } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openIngressSession, serveIngressSession } from "./ingress-protocol.js";

/* THE WHOLE CHAIN, IN PROCESS, exactly as the two consumers wire it:
 *
 *   node http client ─h1→ FRONT server (the ingress) ─h2 stream→ duplex pair ─h2 session→ DAEMON half ─h1→ TARGET
 *
 * Driven by node's own http client rather than by calling the exported functions with hand-built objects,
 * because every property worth pinning here is a property of the BYTES: that a 4MB body survives, that a
 * response arrives in pieces instead of being buffered whole, that a WebSocket's `Sec-WebSocket-Accept` is the
 * daemon's own and not a recomputation, that a half-close reaches the far end. A fake IncomingMessage proves
 * none of those, and each of them is a way this file can be wrong while type-checking perfectly.
 *
 * The front server IS the shape the ingress uses (request → forwardRequest, upgrade → forwardUpgrade, a 502
 * when either rejects with nothing yet said to the browser), so a regression in the promise contract fails
 * here rather than in the ingress package alone. */

const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
};

/* Two halves of a test that have to happen in a fixed ORDER without either measuring time: the gate is opened
 * by the far end observing something, and the near end waits for that rather than for a duration. A gate that
 * is never opened fails as the suite's own hang bound, which is the correct report — "the bytes never arrived"
 * is the failure, and no duration in this file would be measuring anything else. */
const gate = <T = void>(): { readonly open: (value: T) => void; readonly opened: Promise<T> } => {
    let open = (_value: T): void => {};
    const opened = new Promise<T>((resolve) => {
        open = resolve;
    });
    return { open, opened };
};

const HOST = "sandbox-0123456789ab.sbx.test";

// What the target saw, as the target's own answer, so the assertions are about a real server's view of the
// forwarded request rather than about the proxy's bookkeeping.
interface Seen {
    readonly method: string;
    readonly url: string;
    readonly host: string;
    readonly connection: string;
    readonly headerNames: readonly string[];
}

const bodyOf = async (message: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of message) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
};

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const firstChunk = gate();
const secondSent = gate();
const uploadStarted = gate();

// 64KB a write, so a `/flood` response keeps node's write queue non-empty and a reset lands on top of a write
// that has not completed.
const FLOOD_CHUNK = Buffer.alloc(64 * 1024, 7);

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

// One entry per property under test, rather than a chain of ifs: the routes are independent, and a reader
// looking for "what does a cancelled request do" should find one function, not the fifth branch of one.
const routes: Record<string, Route> = {
    "/seen": (request, response) => {
        const seen: Seen = {
            method: request.method ?? "",
            url: request.url ?? "",
            host: request.headers.host ?? "",
            connection: request.headers.connection ?? "",
            headerNames: Object.keys(request.headers).sort(),
        };
        response.writeHead(201, { "content-type": "application/json", "x-target": "yes" });
        response.end(JSON.stringify(seen));
    },
    "/echo": async (request, response) => {
        const bytes = await bodyOf(request);
        response.writeHead(200, { "content-type": "application/octet-stream", "x-sha256": digest(bytes) });
        response.end(bytes);
    },
    // Two writes with the SECOND one held until the client has read the first: a proxy that buffers the whole
    // response before forwarding it deadlocks here instead of passing.
    "/drip": async (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("one");
        await firstChunk.opened;
        response.write("two");
        response.end();
        secondSent.open();
    },
    // The mirror image: the request body's first chunk must reach here before the client sends the rest.
    "/slurp": async (request, response) => {
        request.once("data", () => uploadStarted.open());
        const bytes = await bodyOf(request);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(bytes.toString("utf8"));
    },
    // Never answered: the test asserts that the BROWSER giving up reaches this far, as a close on a response
    // this server is still holding — "aborted", never the "ended" of an exchange that completed.
    "/hangup": (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("open");
        response.on("close", () => cancelled.open(response.writableEnded ? "ended" : "aborted"));
    },
    // A response big enough that writes are still pending when the client resets the stream: the interleaving
    // that the loopback bridge exists to survive.
    "/flood": (_request, response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const pump = (): void => {
            while (response.write(FLOOD_CHUNK)) {
                if (response.writableEnded) {
                    return;
                }
            }
        };
        response.on("drain", pump);
        pump();
    },
};

const target = createServer((request: IncomingMessage, response: ServerResponse) => {
    const route = routes[(request.url ?? "").split("?")[0] ?? ""];
    if (route === undefined) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("no such route");
        return;
    }
    void route(request, response);
});

const cancelled = gate<string>();

/* A real HTTP/1.1 upgrade, hand-written because this package depends on no WebSocket library and does not need
 * one: what the protocol has to carry is the 101 head and the bytes after it. `/refuse` answers instead of
 * upgrading, which is the other branch of the daemon's CONNECT handling. */
target.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url ?? "") === "/refuse") {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 7\r\n\r\nno dice");
        return;
    }
    socket.write(
        [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            // Stands in for Sec-WebSocket-Accept: a value only this server can produce, so reading it back
            // proves the head travelled rather than being reconstructed by the proxy.
            `Sec-WebSocket-Accept: ${digest(Buffer.from(String(request.headers["sec-websocket-key"])))}`,
            `X-Seen-Host: ${String(request.headers.host)}`,
            `X-Seen-Path: ${String(request.url)}`,
            "",
            "",
        ].join("\r\n"),
    );
    if (head.length > 0) {
        socket.write(head);
    }
    socket.on("data", (chunk: Buffer) => void socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    // A FIN from the far end of the whole chain must arrive as a FIN here, or a WebSocket close handshake never
    // completes.
    socket.on("end", () => void socket.end("bye"));
});

// The ingress's shape: one session, every request routed through it per request.
const front = async (
    targetPort: number,
): Promise<{ readonly server: Server; readonly poison: (bytes: Buffer) => void; readonly close: () => void }> => {
    const [edgeSide, daemonSide] = duplexPair();
    const daemon = await serveIngressSession(daemonSide, { targetPort });
    const session = await openIngressSession(edgeSide);
    const server = createServer((request, response) => {
        void session.forwardRequest(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(502, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "sandbox unreachable" }));
                return;
            }
            response.destroy();
        });
    });
    server.on("upgrade", (request, socket, head) => {
        void session.forwardUpgrade(request, socket, head).catch(() => {
            socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
    });
    return {
        server,
        // Garbage straight onto the wire the edge reads, interleaved with whatever the daemon half is sending:
        // what a wedged peer or a half-open socket that came back wrong looks like from the ingress's side.
        poison: (bytes: Buffer) => void daemonSide.write(bytes),
        close: () => {
            session.close();
            daemon.close();
            server.close();
        },
    };
};

let edge: Awaited<ReturnType<typeof front>>;
let edgePort = 0;

/* Every ERR_INTERNAL_ASSERTION this module can produce arrives as an uncaught exception from inside node, with
 * none of our frames on the stack — so it is caught HERE or not at all, and a test that merely "passed" while
 * the process was dying is exactly the report that hid this the first time. */
const uncaught: string[] = [];

beforeAll(async () => {
    process.on("uncaughtException", (error: NodeJS.ErrnoException) => void uncaught.push(error.code ?? error.message));
    const targetPort = await listen(target);
    edge = await front(targetPort);
    edgePort = await listen(edge.server);
});

afterAll(() => {
    edge.close();
    target.close();
});

const call = (
    path: string,
    options: { readonly method?: string; readonly body?: Buffer; readonly headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; body: Buffer }> =>
    new Promise((resolve, reject) => {
        const request = h1Request(
            { host: "127.0.0.1", port: edgePort, path, method: options.method ?? "GET", headers: { host: HOST, ...options.headers } },
            (response) => {
                void bodyOf(response).then((body) =>
                    resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
                );
            },
        );
        request.on("error", reject);
        request.end(options.body);
    });

test("a request round-trips with its authority, path and method, and no hop-by-hop header crosses", async () => {
    const answer = await call("/seen?q=1", {
        method: "PUT",
        // The three the browser must not be able to push through a hop, alongside two that must survive it.
        headers: { "x-custom": "kept", "x-forwarded-proto": "https", connection: "close", upgrade: "h2c", "keep-alive": "timeout=99" },
        body: Buffer.from("hi"),
    });

    expect(answer.status).toBe(201);
    expect(answer.headers["x-target"]).toBe("yes");
    const seen = JSON.parse(answer.body.toString("utf8")) as Seen;
    // The Host the browser used is what the daemon's own listener sees — how a preview, a forwarded port and
    // the daemon itself are told apart inside the container.
    expect(seen).toMatchObject({ method: "PUT", url: "/seen?q=1", host: HOST });
    expect(seen.headerNames).toContain("x-custom");
    expect(seen.headerNames).toContain("x-forwarded-proto");
    /* Hop-by-hop headers describe ONE hop and are re-derived on each, never forwarded. `connection` is the
     * assertion that says so by value: the browser sent `close`, and what reaches the target is the `keep-alive`
     * of the daemon's own loopback hop. Asserting merely that the target sees no `connection` would be asserting
     * something false — node writes one for its own hop — and would pass just as well if the browser's value had
     * been forwarded and then overwritten. */
    expect(seen.connection).toBe("keep-alive");
    expect(seen.headerNames).not.toContain("upgrade");
    expect(seen.headerNames).not.toContain("keep-alive");
    expect(seen.headerNames).not.toContain("transfer-encoding");
});

test("a multi-megabyte body survives in both directions, byte for byte", async () => {
    const payload = randomBytes(4 * 1024 * 1024);
    const answer = await call("/echo", { method: "POST", body: payload });

    expect(answer.status).toBe(200);
    // The target's own digest of what it received, and ours of what came back: one assertion per direction,
    // and neither can pass on a truncated or re-ordered stream.
    expect(answer.headers["x-sha256"]).toBe(digest(payload));
    expect(digest(answer.body)).toBe(digest(payload));
});

test("a response is streamed, not buffered: the client reads chunk one before the target writes chunk two", async () => {
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
        const request = h1Request({ host: "127.0.0.1", port: edgePort, path: "/drip", headers: { host: HOST } }, (response) => {
            response.on("data", (chunk: Buffer) => {
                chunks.push(chunk.toString("utf8"));
                firstChunk.open();
            });
            response.on("end", resolve);
            response.on("error", reject);
        });
        request.on("error", reject);
        request.end();
    });
    await done;
    await secondSent.opened;

    expect(chunks.join("")).toBe("onetwo");
    // Two writes, two reads: coalesced into one would mean the proxy held the first until the body was
    // complete, which is the failure this asserts against.
    expect(chunks.length).toBeGreaterThan(1);
});

test("a request body is streamed: the target reads the first chunk before the client sends the rest", async () => {
    const answered = new Promise<string>((resolve, reject) => {
        const request = h1Request(
            { host: "127.0.0.1", port: edgePort, path: "/slurp", method: "POST", headers: { host: HOST } },
            (response) => void bodyOf(response).then((body) => resolve(body.toString("utf8"))),
        );
        request.on("error", reject);
        request.write("one");
        void uploadStarted.opened.then(() => request.end("two"));
    });

    expect(await answered).toBe("onetwo");
});

test("an upgrade splices raw bytes, carries the far end's own handshake head, and passes a half-close through", async () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const upgraded = await new Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; socket: Duplex }>((resolve, reject) => {
        const request = h1Request({
            host: "127.0.0.1",
            port: edgePort,
            path: "/socket",
            headers: { host: HOST, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key },
        });
        request.on("upgrade", (response, socket, head) => {
            expect(head.length).toBe(0);
            resolve({ status: response.statusCode ?? 0, headers: response.headers, socket });
        });
        request.on("response", (response) => reject(new Error(`the upgrade was answered with ${String(response.statusCode)}`)));
        request.on("error", reject);
        request.end();
    });

    expect(upgraded.status).toBe(101);
    // Computed by the target from the key the browser sent, and therefore proof that the original request
    // headers reached it through the CONNECT envelope AND that its answer came back verbatim.
    expect(upgraded.headers["sec-websocket-accept"]).toBe(digest(Buffer.from(key)));
    expect(upgraded.headers["x-seen-host"]).toBe(HOST);
    expect(upgraded.headers["x-seen-path"]).toBe("/socket");

    const spliced = new Promise<string>((resolve) => {
        let read = "";
        upgraded.socket.on("data", (chunk: Buffer) => {
            read += chunk.toString("utf8");
        });
        upgraded.socket.on("end", () => resolve(read));
    });
    upgraded.socket.write("abc");
    // Half-close: the far end must see the FIN, answer on the still-open direction, and then end.
    upgraded.socket.end();

    expect(await spliced).toBe("echo:abcbye");
});

test("a local server that declines to upgrade answers the browser itself", async () => {
    const declined = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const request = h1Request({
            host: "127.0.0.1",
            port: edgePort,
            path: "/refuse",
            headers: { host: HOST, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "x" },
        });
        request.on("upgrade", () => reject(new Error("the target refused, so nothing should have been spliced")));
        request.on("response", (response) => void bodyOf(response).then((body) => resolve({ status: response.statusCode ?? 0, body })));
        request.on("error", reject);
        request.end();
    });

    expect(declined.status).toBe(404);
    expect(declined.body.toString("utf8")).toBe("no dice");
});

test("a browser that gives up cancels the stream all the way to the target", async () => {
    const request = h1Request({ host: "127.0.0.1", port: edgePort, path: "/hangup", headers: { host: HOST } });
    await new Promise<void>((resolve, reject) => {
        request.on("response", (response) => {
            response.once("data", () => resolve());
            response.on("error", () => resolve());
        });
        request.on("error", reject);
        request.end();
    });
    request.destroy();

    // Without the RST_STREAM this asserts, the target keeps generating a response for a browser that is gone,
    // for as long as the container lives.
    await expect(cancelled.opened).resolves.toBe("aborted");
});

test("a tunnel whose target is not listening fails the exchange rather than answering for it", async () => {
    // A port nothing serves: the daemon half cannot reach a listener, so the exchange must fail in a way the
    // ingress can turn into its own 502 — the body naming the host label is the ingress's to write, not this
    // module's.
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise<void>((resolve) => void dead.close(() => resolve()));

    const [edgeSide, daemonSide] = duplexPair();
    const daemon = await serveIngressSession(daemonSide, { targetPort: deadPort });
    const session = await openIngressSession(edgeSide);
    // What the ingress needs to be true of the rejection, reported through the answer rather than asserted
    // inside a catch nothing awaits: it is free to write a status, so nothing was said to the browser first.
    const said = gate<boolean>();
    const server = createServer((request, response) => {
        void session.forwardRequest(request, response).catch(() => {
            said.open(response.headersSent);
            response.writeHead(502, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "sandbox unreachable" }));
        });
    });
    const port = await listen(server);

    const answer = await new Promise<number>((resolve, reject) => {
        const request = h1Request({ host: "127.0.0.1", port, path: "/anything", headers: { host: HOST } }, (response) =>
            resolve(response.statusCode ?? 0),
        );
        request.on("error", reject);
        request.end();
    });

    expect(answer).toBe(502);
    await expect(said.opened).resolves.toBe(false);
    session.close();
    daemon.close();
    server.close();
});

/* THE REGRESSION THIS MODULE'S TRANSPORT EXISTS FOR. Reset a batch of streams that are mid-write and the h2
 * session emits control frames on top of writes that have not completed — which, run directly over a Duplex,
 * is node's one-write-per-turn JSStreamSocket invariant and an ERR_INTERNAL_ASSERTION out of an internal
 * callback. Measured twice over: the process died, AND the RST_STREAM never went out, so the cancellation
 * never reached the container.
 *
 * Driven entirely through the public API, so it keeps pinning the behaviour however the transport is built. If
 * someone removes the loopback bridge because "http2 takes a Duplex", this is the test that goes red. */
test("a shutdown landing on top of pending writes neither crashes nor wedges the session", async () => {
    const own = await front((target.address() as AddressInfo).port);
    const ownPort = await listen(own.server);

    /* Eight responses actively writing, each confirmed to be delivering bytes before the shutdown, so node's
     * write queue is genuinely non-empty when the GOAWAY is produced. All eight stay live on purpose: an
     * earlier version of this test reset half of them first and passed against the broken transport, because
     * the resets drained the very pressure the shutdown has to land on top of. (The reset path has its own
     * test above; what is being pinned here is a control frame written over pending data.) */
    const flooding = Array.from({ length: 8 }, () =>
        new Promise<void>((resolve) => {
            const request = h1Request({ host: "127.0.0.1", port: ownPort, path: "/flood", headers: { host: HOST } }, (response) => {
                response.once("data", () => resolve());
            });
            request.on("error", () => resolve());
            request.end();
        }),
    );
    await Promise.all(flooding);

    own.close();
    await new Promise((resolve) => setTimeout(resolve, 400));
    own.server.close();

    /* Two ways to fail, and the suite's own budget is the second one. Run straight over a Duplex this hangs:
     * the shutdown frame cannot be written, so `close()` never completes and the tunnel wedges holding every
     * stream on it — which is why a hang bound, rather than a duration, is the right report here. */
    expect(uncaught).toStrictEqual([]);
    // And the neighbours are untouched: the shared fixture's session still serves.
    const after = await call("/seen");
    expect(after.status).toBe(201);
});

/* CONTAINMENT: one tunnel's session dying must be one tunnel's problem. The ingress holds every sandbox's
 * session in a single process, so a peer that speaks nonsense — a wedged container, a half-open socket that
 * came back as garbage, anything that makes nghttp2 give up — is the failure most likely to be shared, and it
 * must not be. */
test("a poisoned session dies alone and leaves another tunnel serving", async () => {
    const targetPort = (target.address() as AddressInfo).port;
    const poisoned = await front(targetPort);
    const poisonedPort = await listen(poisoned.server);
    const healthy = await front(targetPort);
    const healthyPort = await listen(healthy.server);

    const through = (port: number): Promise<number> =>
        new Promise((resolve, reject) => {
            const request = h1Request({ host: "127.0.0.1", port, path: "/seen", headers: { host: HOST } }, (response) => {
                void bodyOf(response).then(() => resolve(response.statusCode ?? 0));
            });
            request.on("error", reject);
            request.end();
        });

    expect(await through(poisonedPort)).toBe(201);
    expect(await through(healthyPort)).toBe(201);

    // Not an h2 frame by any reading: the session must fail rather than try to interpret it.
    poisoned.poison(Buffer.from("this is not a PRI * HTTP/2.0 preface, nor anything else nghttp2 accepts"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The dead session refuses new streams, which the front turns into its 502 — the tunnel is gone, and that
    // is a routing fact rather than a crash.
    expect(await through(poisonedPort)).toBe(502);
    expect(uncaught).toStrictEqual([]);
    // The whole point: the other tunnel never noticed.
    expect(await through(healthyPort)).toBe(201);

    poisoned.close();
    healthy.close();
});
