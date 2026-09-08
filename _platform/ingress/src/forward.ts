import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { HOP_HEADER } from "./cluster.js";
import type { Peer } from "./peers.js";

// Hands a request to the peer holding the tunnel, over the private network as plain HTTP, Host intact so it routes
// exactly like one from the internet.
// Streams, not buffers, in both directions and for upgrades, with no timeout; fly-replay is not used since it caps the
// body and can't cross hosts.
// `PeerUnreachable` is the failure the cluster acts on, by forgetting the holder.

export class PeerUnreachable extends Error {
    constructor(
        readonly peer: Peer,
        cause: Error,
    ) {
        super(`peer ${peer.host}:${peer.port} unreachable: ${cause.message}`, { cause });
        this.name = `PeerUnreachable`;
    }
}

// Node's connect-level failures: the peer is not there, not that it refused the request.
const CONNECT_ERRORS = new Set([`ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`]);

const isConnectError = (error: Error): boolean => `code` in error && CONNECT_ERRORS.has(String(error.code));

const asPeerError = (peer: Peer, error: Error): Error => (isConnectError(error) ? new PeerUnreachable(peer, error) : error);

// Appends the browser's own address, so the holding machine's logs show a browser, not a peer.
const forwardedFor = (request: IncomingMessage): string => {
    const existing = request.headers[`x-forwarded-for`];
    const address = request.socket.remoteAddress ?? ``;
    return existing === undefined ? address : `${Array.isArray(existing) ? existing.join(`, `) : existing}, ${address}`;
};

const forwardHeaders = (request: IncomingMessage): Record<string, string | string[]> => {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
            headers[name] = value;
        }
    }
    headers[HOP_HEADER] = `1`;
    headers[`x-forwarded-for`] = forwardedFor(request);
    return headers;
};

const upstreamOptions = (peer: Peer, request: IncomingMessage) => ({
    host: peer.host,
    port: peer.port,
    method: request.method,
    path: request.url,
    headers: forwardHeaders(request),
    // Host is already forwarded in the headers; the peer routes by that, not this option.
    setHost: false,
});

export const forwardRequest = (peer: Peer, request: IncomingMessage, response: ServerResponse): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(upstreamOptions(peer, request), (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
            answer.on(`error`, (error: Error) => reject(error));
            answer.pipe(response).on(`finish`, () => resolve());
        });
        upstream.on(`error`, (error: Error) => reject(asPeerError(peer, error)));
        // Browser going away mid-body ends the upstream stream too.
        response.on(`close`, () => upstream.destroy());
        request.pipe(upstream);
    });

// Peer's 101 response line and headers, written back to the browser's socket verbatim.
const upgradeHead = (answer: IncomingMessage): string => {
    const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? `Switching Protocols`}`];
    for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
    }
    return `${lines.join(`\r\n`)}\r\n\r\n`;
};

// Forwards the upgrade request until the peer answers with 101, then splices the two sockets and reads nothing further.
// A different answer is relayed as a refusal on the raw socket instead of a hang; nothing is written before the peer
// answers.
export const forwardUpgrade = (peer: Peer, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(upstreamOptions(peer, request));
        upstream.on(`upgrade`, (answer, upstreamSocket, upstreamHead) => {
            socket.write(upgradeHead(answer));
            if (upstreamHead.length > 0) {
                socket.write(upstreamHead);
            }
            if (head.length > 0) {
                upstreamSocket.write(head);
            }
            socket.pipe(upstreamSocket).pipe(socket);
            socket.on(`error`, () => upstreamSocket.destroy());
            upstreamSocket.on(`error`, () => socket.destroy());
            resolve();
        });
        upstream.on(`response`, (answer) => {
            // Peer refused the upgrade: relay its response as the refusal, then close.
            const chunks: Buffer[] = [];
            answer.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            answer.on(`end`, () => {
                const body = Buffer.concat(chunks);
                socket.end(
                    `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? `Bad Gateway`}\r\n` +
                        `Content-Type: ${answer.headers[`content-type`] ?? `text/plain; charset=utf-8`}\r\n` +
                        `Content-Length: ${body.length}\r\n` +
                        `Connection: close\r\n\r\n${body.toString(`utf8`)}`,
                );
                resolve();
            });
        });
        upstream.on(`error`, (error: Error) => reject(asPeerError(peer, error)));
        upstream.end();
    });
