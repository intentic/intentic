import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, request as h1Request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Duplex, duplexPair } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openIngressSession, serveIngressSession } from "./ingress-protocol.js";

// Drives the full ingress-to-daemon chain (front server, duplex pair, target) through node's real http client, in
// process, so streaming, half-close and header identity are pinned as bytes, not shapes.

const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
};

// Coordinates a fixed order between two halves without measuring time: the near end waits on the far end's signal; an
// unopened gate fails as the suite's own hang timeout.
const gate = <T = void>(): { readonly open: (value: T) => void; readonly opened: Promise<T> } => {
    let open = (_value: T): void => {};
    const opened = new Promise<T>((resolve) => {
        open = resolve;
    });
    return { open, opened };
};

const HOST = "sandbox-0123456789ab.sbx.test";

// What the target saw, mirrored back as its own response, so assertions read a real server's view rather than the
// proxy's bookkeeping.
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

// 64KB per write, keeping node's write queue non-empty so a reset lands on an unfinished write.
const FLOOD_CHUNK = Buffer.alloc(64 * 1024, 7);

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

// One route per property under test, not a branch of one handler, so each behavior has its own function.
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
    // Second write waits for the client to read the first; a proxy that buffers the whole response deadlocks here.
    "/drip": async (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("one");
        await firstChunk.opened;
        response.write("two");
        response.end();
        secondSent.open();
    },
    // Mirror of /drip: the first body chunk must arrive here before the client sends the rest.
    "/slurp": async (request, response) => {
        request.once("data", () => uploadStarted.open());
        const bytes = await bodyOf(request);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(bytes.toString("utf8"));
    },
    // Never answered; asserts a client abort surfaces as "aborted", not the "ended" of a completed exchange.
    "/hangup": (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("open");
        response.on("close", () => cancelled.open(response.writableEnded ? "ended" : "aborted"));
    },
    // Large enough that writes are still pending when the client resets mid-stream.
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

// Hand-written HTTP/1.1 upgrade carrying the 101 head plus the raw bytes after it. `/refuse` answers instead of
// upgrading.
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
            // A value only this server can produce; proves the head travelled rather than being reconstructed.
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
    // A far-end FIN must arrive here or the close handshake never completes.
    socket.on("end", () => void socket.end("bye"));
});

// One session; every request is routed through it.
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
        // Writes garbage onto the wire the edge reads, simulating a wedged or corrupted peer.
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

// Node-internal assertion failures surface only as an uncaughtException with none of our frames on the stack; caught
// here or not at all.
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
        // Three headers that must not cross a hop, plus two that must survive it.
        headers: { "x-custom": "kept", "x-forwarded-proto": "https", connection: "close", upgrade: "h2c", "keep-alive": "timeout=99" },
        body: Buffer.from("hi"),
    });

    expect(answer.status).toBe(201);
    expect(answer.headers["x-target"]).toBe("yes");
    const seen = JSON.parse(answer.body.toString("utf8")) as Seen;
    expect(seen).toMatchObject({ method: "PUT", url: "/seen?q=1", host: HOST });
    expect(seen.headerNames).toContain("x-custom");
    expect(seen.headerNames).toContain("x-forwarded-proto");
    expect(seen.connection).toBe("keep-alive");
    expect(seen.headerNames).not.toContain("upgrade");
    expect(seen.headerNames).not.toContain("keep-alive");
    expect(seen.headerNames).not.toContain("transfer-encoding");
});

test("a multi-megabyte body survives in both directions, byte for byte", async () => {
    const payload = randomBytes(4 * 1024 * 1024);
    const answer = await call("/echo", { method: "POST", body: payload });

    expect(answer.status).toBe(200);
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

    await expect(cancelled.opened).resolves.toBe("aborted");
});

test("a tunnel whose target is not listening fails the exchange rather than answering for it", async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise<void>((resolve) => void dead.close(() => resolve()));

    const [edgeSide, daemonSide] = duplexPair();
    const daemon = await serveIngressSession(daemonSide, { targetPort: deadPort });
    const session = await openIngressSession(edgeSide);
    // True if a status was already written before the rejection handler runs.
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

test("a shutdown landing on top of pending writes neither crashes nor wedges the session", async () => {
    const own = await front((target.address() as AddressInfo).port);
    const ownPort = await listen(own.server);

    // All eight stay live: resetting some first would drain the pending-write pressure the shutdown needs to land on.
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

    // If the shutdown frame can't be written, this hangs; the suite's timeout is the failure signal, not an assertion.
    expect(uncaught).toStrictEqual([]);
    const after = await call("/seen");
    expect(after.status).toBe(201);
});

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

    // Not a valid h2 preface; the session must fail rather than parse it.
    poisoned.poison(Buffer.from("this is not a PRI * HTTP/2.0 preface, nor anything else nghttp2 accepts"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(await through(poisonedPort)).toBe(502);
    expect(uncaught).toStrictEqual([]);
    expect(await through(healthyPort)).toBe(201);

    poisoned.close();
    healthy.close();
});
