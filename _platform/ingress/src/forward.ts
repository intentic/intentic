import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { HOP_HEADER } from "./cluster.js";
import type { Peer } from "./peers.js";

/* HANDING A REQUEST TO THE MACHINE THAT HOLDS THE TUNNEL, over the private network, as plain HTTP.
 *
 * The peer gets the request on its PUBLIC port, with the browser's Host intact, so it routes it exactly like
 * one that arrived from the internet: hostOwnerId, registry, tunnel. Nothing on the receiving side knows it
 * was forwarded except the hop header, which is what stops it from forwarding again (cluster.ts) and which the
 * edge strips before the request goes down a tunnel, so a workspace never sees it.
 *
 * WHY NOT fly-replay. Fly's proxy can replay a request to a named machine, and it would spare this process
 * from carrying the bytes twice — but it buffers the body it replays, capped at a megabyte, and a file upload
 * or a large paste is exactly the request that would silently break. It is also Fly's alone, and the edge has
 * to work in a compose file across two hosts. Node core streams both directions with no such ceiling.
 *
 * STREAMS, NOT BUFFERS, in both directions and for upgrades, because the traffic is terminals, agent turns,
 * SSE and a dev server's HMR socket — the same long-lived streams the edge itself refuses to time out. The
 * upstream request carries no timeout for the same reason server.ts sets none.
 *
 * WHAT A FAILURE MEANS is the same contract IngressSession has (ingress-protocol.ts): a rejection with nothing
 * yet said to the browser is the caller's 502 to write; a rejection after headers went out is a truncated
 * body on a reset socket, the only honest signal HTTP has left. `PeerUnreachable` is the one the cluster
 * acts on — the machine is gone or not listening — by forgetting the holder. */

export class PeerUnreachable extends Error {
    constructor(
        readonly peer: Peer,
        cause: Error,
    ) {
        super(`peer ${peer.host}:${peer.port} unreachable: ${cause.message}`, { cause });
        this.name = `PeerUnreachable`;
    }
}

// Node's connect-level failures, which are "the peer is not there" rather than "the peer said no".
const CONNECT_ERRORS = new Set([`ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`]);

const isConnectError = (error: Error): boolean => `code` in error && CONNECT_ERRORS.has(String(error.code));

const asPeerError = (peer: Peer, error: Error): Error => (isConnectError(error) ? new PeerUnreachable(peer, error) : error);

// The browser's own address, appended so the holding machine's logs see a browser rather than a peer.
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
    // The browser's Host is already in the headers, and it is the one the peer routes by.
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
        // The browser going away mid-body is the browser's business, and the upstream stream ends with it.
        response.on(`close`, () => upstream.destroy());
        request.pipe(upstream);
    });

// The peer's 101, written back to the browser's socket the way node would have written it.
const upgradeHead = (answer: IncomingMessage): string => {
    const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? `Switching Protocols`}`];
    for (let index = 0; index < answer.rawHeaders.length; index += 2) {
        lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
    }
    return `${lines.join(`\r\n`)}\r\n\r\n`;
};

/* An upgrade is a request until the far end says 101, and this forwards it as one: node fires `upgrade` on
 * the client request when the peer switches protocols, and from then on the two sockets are spliced and
 * nothing here looks at another byte. A peer that answers anything else (a 502 for a sandbox it turned out
 * not to hold, a 404) is relayed as that answer on the raw socket, which is a refusal the browser can read
 * rather than a hang. Nothing is written to `socket` before the peer has answered, so a connect failure
 * leaves it untouched for the caller to refuse on. */
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
            // Not an upgrade: relay the refusal head and body, then close, since there is no session to keep.
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
