// The move tier uses the real Docker Desktop daemon through a fixture-only inventory. Its isolated ic home may
// switch engines; the Windows runner's own sandboxes must never be selected, even legacy ones without a keeper stamp.
import { createServer, request, type ClientRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { openEngineDockerStream } from "./engine-docker-stream.js";
import { sandboxContainerName } from "./parse.js";
import { ENGINE_SANDBOX_HOSTNAME } from "./engine.js";

const sandbox = sandboxContainerName(ENGINE_SANDBOX_HOSTNAME);
const slug = sandbox.slice("intentic-sandbox-".length);
const names = [sandbox, `intentic-sandbox-tunnel-${slug}`, `intentic-dind-host-${slug}`];
const fixtureName = (name: string): boolean => names.some((base) => name === base || name === `${base}.previous` || name === `${base}.moved`)
    || name.startsWith(`intentic-move-${slug}-`);

interface ContainerRow {
    readonly Id: string;
    readonly Names: readonly string[];
}

interface Boundary {
    readonly containers: Set<string>;
    readonly execs: Set<string>;
}

const containerAllowed = (boundary: Boundary, name: string): boolean => fixtureName(name)
    || [...boundary.containers].some((id) => name.length >= 12 && id.startsWith(name));

const allowed = (boundary: Boundary, url: URL): boolean => {
    const path = decodeURIComponent(url.pathname).replace(/^\/v\d+\.\d+/, "");
    if (path === "/containers/create") {
        const name = url.searchParams.get("name");
        return name === null || fixtureName(name);
    }
    if (path === "/containers/json") { return true; }
    const container = /^\/containers\/([^/]+)/.exec(path)?.[1];
    if (container !== undefined) {
        const rename = url.searchParams.get("name");
        return containerAllowed(boundary, container) && (rename === null || fixtureName(rename));
    }
    const exec = /^\/exec\/([^/]+)/.exec(path)?.[1];
    if (exec !== undefined) { return boundary.execs.has(exec); }
    if (path === "/commit") { return containerAllowed(boundary, url.searchParams.get("container") ?? ""); }
    return true;
};

const readJson = (boundary: Boundary, path: string, body: Buffer): Buffer => {
    if (path.endsWith("/containers/json")) {
        // SAFETY: Docker's container-list endpoint returns rows with Id and Names.
        const rows = (JSON.parse(body.toString()) as ContainerRow[]).filter((row) => row.Names.some((name) => fixtureName(name.replace(/^\//, ""))));
        for (const row of rows) { boundary.containers.add(row.Id); }
        return Buffer.from(JSON.stringify(rows));
    }
    // SAFETY: Docker's container inspect/create and exec-create endpoints return an Id.
    const value = JSON.parse(body.toString()) as { Id?: string };
    if (value.Id !== undefined) {
        if (path.endsWith("/exec")) { boundary.execs.add(value.Id); }
        else { boundary.containers.add(value.Id); }
    }
    return body;
};

const transfer = (boundary: Boundary, path: string, upstream: IncomingMessage, downstream: ServerResponse): void => {
    upstream.once("error", () => downstream.destroy());
    const capture = upstream.statusCode === 200 || upstream.statusCode === 201;
    if (!capture || !/(?:\/containers\/json|\/containers\/create|\/containers\/[^/]+\/(?:json|exec))$/.test(path)) {
        downstream.writeHead(upstream.statusCode ?? 502, upstream.headers);
        // Docker waits for these headers before starting an attached container; the body arrives after it exits.
        downstream.flushHeaders();
        upstream.pipe(downstream);
        return;
    }
    const chunks: Buffer[] = [];
    upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstream.on("end", () => {
        try {
            const body = readJson(boundary, path, Buffer.concat(chunks));
            const headers = { ...upstream.headers };
            delete headers["transfer-encoding"];
            downstream.writeHead(upstream.statusCode ?? 502, { ...headers, "content-length": body.length });
            downstream.end(body);
        } catch {
            downstream.writeHead(502).end("invalid Docker inventory response");
        }
    });
};

/** The upstream is Docker Desktop's named pipe in CI; an HTTP fixture in its integration test. */
export const startEngineDockerProxy = async (upstream: RequestOptions): Promise<{ host: string; close: () => Promise<void> }> => {
    const boundary: Boundary = { containers: new Set(), execs: new Set() };
    const sockets = new Set<Socket>();
    const requests = new Set<ClientRequest>();
    const bridges = new Set<Duplex>();
    const server = createServer((incoming, outgoing) => {
        const url = new URL(incoming.url ?? "/", "http://docker.local");
        if (!allowed(boundary, url)) {
            outgoing.writeHead(403).end(JSON.stringify({ message: "the engine smoke may only reach its own containers" }));
            return;
        }
        const forwarded = request({ ...upstream, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
            transfer(boundary, url.pathname, response, outgoing);
        });
        requests.add(forwarded);
        forwarded.once("close", () => requests.delete(forwarded));
        // A cancelled wait/events client must release the daemon stream too, or its pipe keeps Node alive forever.
        outgoing.once("close", () => forwarded.destroy());
        incoming.once("aborted", () => forwarded.destroy());
        forwarded.on("error", () => {
            if (outgoing.destroyed) { return; }
            if (outgoing.headersSent) { outgoing.destroy(); return; }
            outgoing.writeHead(502).end("Docker Desktop did not answer");
        });
        if (incoming.headers["content-type"]?.startsWith("application/json")) {
            // Docker Desktop's Windows pipe rejects a create body streamed separately from its HTTP headers.
            // Metadata is small; send it with end(body), while archives and other bulk streams keep piping.
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => forwarded.end(Buffer.concat(chunks)));
        } else {
            incoming.pipe(forwarded);
        }
    });
    // docker exec/attach use an HTTP upgrade for their byte stream. Enforce the same container/exec boundary first.
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.on("upgrade", (incoming, socket, head) => {
        const url = new URL(incoming.url ?? "/", "http://docker.local");
        if (!allowed(boundary, url)) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
        // Forward the HTTP handshake as bytes too: exec-start may carry a body before the daemon upgrades,
        // and Docker versions use both 101 and a hijacked 200 response for the resulting stream.
        void openEngineDockerStream(upstream).then((peer) => {
            if (socket.destroyed || peer.destroyed) { socket.destroy(); peer.destroy(); return; }
            bridges.add(peer);
            peer.once("close", () => bridges.delete(peer));
            peer.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n`);
            for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
                peer.write(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}\r\n`);
            }
            peer.write("\r\n");
            peer.write(head);
            socket.pipe(peer).pipe(socket);
            socket.on("error", () => peer.destroy());
            socket.once("close", () => peer.destroy());
            peer.on("error", () => socket.destroy());
        }).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    // SAFETY: listen above has completed on an ephemeral TCP port, never on a Unix socket.
    const address = server.address() as AddressInfo;
    return {
        host: `tcp://127.0.0.1:${address.port}`,
        close: async () => {
            for (const socket of sockets) { socket.destroy(); }
            for (const pending of requests) { pending.destroy(); }
            for (const bridge of bridges) { bridge.destroy(); }
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
};
