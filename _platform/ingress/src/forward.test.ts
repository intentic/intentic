import { createServer, request as h1Request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HOP_HEADER } from "./cluster.js";
import { forwardRequest, forwardUpgrade, PeerUnreachable } from "./forward.js";
import type { Peer } from "./peers.js";

/* A REQUEST HANDED FROM ONE EDGE TO ANOTHER, over real sockets: a "peer" that answers like the holding machine
 * would, an "edge" that forwards everything to it, and a client that only ever talks to the edge. What has to
 * survive the hop is the Host (it is the whole of routing on the far side), the body in both directions, and
 * an upgrade — and a failure has to be a readable answer rather than a hang. */

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

describe(`forwarding to a peer`, () => {
    let peerServer: Server;
    let edge: Server;
    let peer: Peer;
    let seen: IncomingMessage | undefined;

    beforeAll(async () => {
        peerServer = createServer((request, response) => {
            seen = request;
            const chunks: Buffer[] = [];
            request.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            request.on(`end`, () => {
                response.writeHead(200, { "content-type": `text/plain`, "x-answered-by": `peer` });
                response.end(`served ${request.headers.host}${request.url} body=${Buffer.concat(chunks).toString(`utf8`)}`);
            });
        });
        // An echo upgrade, and a refusal for a host it does not hold.
        peerServer.on(`upgrade`, (request, socket: Socket) => {
            seen = request;
            if (request.headers.host?.startsWith(`nobody`)) {
                socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope`);
                return;
            }
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
            socket.pipe(socket);
        });
        await new Promise<void>((resolve) => peerServer.listen(0, `127.0.0.1`, resolve));
        peer = { host: `127.0.0.1`, port: portOf(peerServer), internalPort: 0 };

        edge = createServer((request, response) => {
            void forwardRequest(peer, request, response).catch(() => {
                response.writeHead(502);
                response.end(`edge: peer failed`);
            });
        });
        edge.on(`upgrade`, (request, socket: Socket, head) => {
            void forwardUpgrade(peer, request, socket, head).catch(() => socket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`));
        });
        await new Promise<void>((resolve) => edge.listen(0, `127.0.0.1`, resolve));
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => edge.close(() => resolve()));
        await new Promise<void>((resolve) => peerServer.close(() => resolve()));
    });

    test(`carries the Host, the body and the answer across, and marks the hop`, async () => {
        const answer = await new Promise<{ status: number; body: string; answeredBy: string | undefined }>((resolve, reject) => {
            const request = h1Request(
                { host: `127.0.0.1`, port: portOf(edge), method: `POST`, path: `/api/x?y=1`, headers: { host: `sandbox-abcdef012345.zone.test` } },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on(`data`, (chunk: Buffer) => chunks.push(chunk));
                    response.on(`end`, () =>
                        resolve({
                            status: response.statusCode ?? 0,
                            body: Buffer.concat(chunks).toString(`utf8`),
                            answeredBy: response.headers[`x-answered-by`]?.toString(),
                        }),
                    );
                },
            );
            request.on(`error`, reject);
            request.end(`hello`);
        });

        expect(answer).toEqual({ status: 200, body: `served sandbox-abcdef012345.zone.test/api/x?y=1 body=hello`, answeredBy: `peer` });
        expect(seen?.headers[HOP_HEADER]).toBe(`1`);
        expect(seen?.headers[`x-forwarded-for`]).toBe(`127.0.0.1`);
    });

    test(`splices an upgrade through, bytes both ways`, async () => {
        const echoed = await new Promise<string>((resolve, reject) => {
            const request = h1Request({
                host: `127.0.0.1`,
                port: portOf(edge),
                path: `/ws`,
                headers: { host: `sandbox-abcdef012345.zone.test`, connection: `Upgrade`, upgrade: `echo` },
            });
            request.on(`upgrade`, (response, socket: Socket) => {
                expect(response.statusCode).toBe(101);
                expect(response.headers.upgrade).toBe(`echo`);
                socket.write(`ping`);
                socket.once(`data`, (chunk: Buffer) => {
                    socket.end();
                    resolve(chunk.toString(`utf8`));
                });
            });
            request.on(`error`, reject);
            request.end();
        });

        expect(echoed).toBe(`ping`);
        expect(seen?.headers[HOP_HEADER]).toBe(`1`);
    });

    // A peer that turns out not to hold the sandbox answers 502 to the upgrade; the browser must read that,
    // not wait on a socket nobody will ever write to.
    test(`relays a refused upgrade as the peer's own answer`, async () => {
        const status = await new Promise<number>((resolve, reject) => {
            const request = h1Request({
                host: `127.0.0.1`,
                port: portOf(edge),
                path: `/ws`,
                headers: { host: `nobody-abcdef012345.zone.test`, connection: `Upgrade`, upgrade: `echo` },
            });
            request.on(`response`, (response) => resolve(response.statusCode ?? 0));
            request.on(`upgrade`, () => reject(new Error(`should not have upgraded`)));
            request.on(`error`, reject);
            request.end();
        });
        expect(status).toBe(502);
    });

    test(`a peer that is not there is a PeerUnreachable, with nothing yet said to the browser`, async () => {
        const gone: Peer = { host: `127.0.0.1`, port: 1, internalPort: 0 };
        let failure: Error | undefined;
        let headersSent: boolean | undefined;
        const lonely = createServer((request, response) => {
            void forwardRequest(gone, request, response).catch((error: Error) => {
                failure = error;
                headersSent = response.headersSent;
                response.writeHead(502);
                response.end();
            });
        });
        await new Promise<void>((resolve) => lonely.listen(0, `127.0.0.1`, resolve));
        const status = await new Promise<number>((resolve, reject) => {
            const request = h1Request({ host: `127.0.0.1`, port: portOf(lonely), path: `/`, headers: { host: `sandbox-abcdef012345.zone.test` } }, (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
            });
            request.on(`error`, reject);
            request.end();
        });
        await new Promise<void>((resolve) => lonely.close(() => resolve()));

        expect(status).toBe(502);
        expect(failure).toBeInstanceOf(PeerUnreachable);
        expect(headersSent).toBe(false);
    });
});
