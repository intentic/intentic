import { INGRESS_GRANT_HEADER, INGRESS_TUNNEL_PATH, hostOwnerId, verifyReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { openIngressSession, webSocketDuplex, type IngressSession } from "@intentic/sandbox-contract/ingress-protocol";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { HOP_HEADER, type Cluster } from "./cluster.js";
import { forwardRequest, forwardUpgrade, PeerUnreachable } from "./forward.js";
import { PING_INTERVAL_MS, startHeartbeat } from "./heartbeat.js";
import type { PeerDiscovery } from "./peers.js";
import { createTunnelRegistry, type TunnelRegistry } from "./registry.js";
import type { Revocation } from "./revocation.js";

/* THE EDGE. One HTTP server doing two unrelated jobs on the same port, and which one a connection gets is
 * decided before anything else happens:
 *
 *   • an upgrade to INGRESS_TUNNEL_PATH is a SANDBOX registering itself — verify the grant, ask the platform
 *     whether the sandbox still exists, then hold the session
 *   • everything else is a BROWSER, routed to a registered tunnel by the Host header's own sandbox id
 *
 * The tunnel door is checked first and by PATH, never by host, because the edge's own hostname carries no
 * sandbox id: `ingress.<zone>` is a label under the same wildcard as every sandbox, and asking `hostOwnerId`
 * about it answers undefined. Checking the path first is what keeps the door reachable at the one name a
 * container can be told about before it has an identity.
 *
 * ROUTING IS PER REQUEST, NEVER PER CONNECTION, and the reason is TLS: the edge terminates one wildcard
 * certificate, and h2 browsers coalesce connections across every name it covers. One TCP connection can carry
 * `sandbox-a…` and `preview-x-b…` interleaved, so a connection has no single owner and routing it as if it did
 * would deliver one sandbox's requests to another. Every handler below reads the Host of the request in front
 * of it and nothing else.
 *
 * THE EDGE HOLDS NOTHING IT COULD LOSE. No database, no name claims, no accounts: the registry is a Map, and
 * a restart is answered by every container's own reconnect loop. That is what makes this process safe to
 * redeploy at any moment.
 *
 * SEVERAL OF THESE BEHIND ONE ADDRESS is the cluster (cluster.ts): a request whose sandbox this machine does
 * not hold is handed to the machine that does (forward.ts), once, and never back. Without a cluster wired in,
 * a local miss is a 502 — which is exactly the one-machine edge this was.
 */

export interface IngressServerOptions {
    // The platform's Ed25519 PUBLIC key (SPKI PEM). The edge can verify grants and can never mint one.
    readonly publicKey: string;
    readonly revocation: Revocation;
    readonly log: (event: Record<string, unknown>, message: string) => void;
    readonly registry?: TunnelRegistry;
    // Where a locally-unknown sandbox may be found. Absent ⇒ one machine, and a miss is a 502.
    readonly cluster?: Cluster;
    // For /health only: how many machines this one knows of.
    readonly peers?: PeerDiscovery;
    readonly instanceId?: string;
    readonly heartbeatIntervalMs?: number;
}

export interface IngressServer {
    readonly server: Server;
    readonly registry: TunnelRegistry;
    readonly listen: (port: number, host: string) => Promise<void>;
    readonly close: () => Promise<void>;
}

// The leftmost DNS label, which is what a 502 names. It is the string the reader recognises — their sandbox's
// address — where the bare 12-hex id is something they have never seen.
const labelOf = (host: string): string => host.split(`:`)[0]?.split(`.`)[0] ?? host;

/* The peer's address, for a log line about a caller that failed the door. An `upgrade` listener is handed a
 * `Duplex` because node makes no promise about the transport — it is a TCP socket here and a TLS one behind a
 * terminator, and neither is guaranteed by the type. Ask, rather than assert: an address is a nicety in a
 * refusal message, and nothing about the refusal depends on having one. */
const remoteAddressOf = (socket: Duplex): string | undefined => (socket instanceof Socket ? socket.remoteAddress : undefined);

/* An error on a HIJACKED socket. Once an upgrade has been taken off the server, node will never write a
 * response for us, so a refusal has to be a hand-written HTTP/1.1 head or the client waits for a timeout with
 * no idea why. `Connection: close` because there is no keep-alive to return to on a socket we are done with. */
const refuse = (socket: Duplex, status: number, reason: string, body: string): void => {
    if (socket.destroyed) {
        return;
    }
    const payload = Buffer.from(`${body}\n`, `utf8`);
    socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n` +
            `Content-Length: ${payload.length}\r\n` +
            `Connection: close\r\n\r\n${ 
            payload.toString(`utf8`)}`,
    );
};

/* NO TUNNEL FOR THIS SANDBOX. 502 rather than 404 deliberately: the browser's availability flow reads any 5xx
 * as "the sandbox is unreachable" and drives the wake, while a 404 reads as "there is no such thing" and stops
 * it. The body names the label because this is the one edge error a person actually meets — a sandbox that is
 * asleep, still booting, or on a machine that was turned off. */
const unreachable = (response: ServerResponse, host: string): void => {
    if (response.headersSent) {
        response.destroy();
        return;
    }
    const label = labelOf(host);
    response.writeHead(502, { "content-type": `text/plain; charset=utf-8`, "cache-control": `no-store` });
    response.end(`${label} is not connected right now.\n`);
};

export const createIngressServer = (options: IngressServerOptions): IngressServer => {
    const registry = options.registry ?? createTunnelRegistry();
    // noServer: this server owns its own upgrade handling — the tunnel door has to be told apart from a
    // browser's WebSocket to a sandbox, and only the path can do that.
    const sockets = new WebSocketServer({ noServer: true });

    /* THE EDGE'S OWN SURFACE: what answers on a host that names no sandbox. Deliberately tiny. `/health` is
     * what a load balancer polls and what proves the process is up; everything else is a stray subdomain the
     * wildcard also catches, and the honest answer to that is 404. */
    const serveEdge = (request: IncomingMessage, response: ServerResponse): void => {
        const path = (request.url ?? `/`).split(`?`)[0];
        if (path === `/health`) {
            response.writeHead(200, { "content-type": `application/json`, "cache-control": `no-store` });
            response.end(
                JSON.stringify({
                    status: `ok`,
                    tunnels: registry.size(),
                    instance: options.instanceId ?? ``,
                    peers: options.peers?.current().length ?? 0,
                    // Ids this machine would forward rather than serve.
                    remote: options.cluster?.remoteCount() ?? 0,
                }),
            );
            return;
        }
        if (path === INGRESS_TUNNEL_PATH) {
            // The door exists, but this is not a knock. Says so rather than 404ing, because a container whose
            // WebSocket library is misconfigured otherwise looks like it has the wrong address entirely.
            response.writeHead(426, { "content-type": `text/plain; charset=utf-8`, upgrade: `websocket` });
            response.end(`the tunnel door takes a websocket upgrade\n`);
            return;
        }
        response.writeHead(404, { "content-type": `text/plain; charset=utf-8` });
        response.end(`no sandbox is named by this address\n`);
    };

    /* WHERE A LOCAL MISS GOES. A request another machine already handed us carries the hop header, and a miss
     * on it is final: the peer that forwarded believed we held the sandbox and was wrong, so answering 502 is
     * what lets it forget that belief, and forwarding again is how a loop would start. A request straight
     * from a browser asks the cluster, which either names the holder or has nothing to add. */
    const holderFor = (sandboxId: string, request: IncomingMessage) =>
        request.headers[HOP_HEADER] === undefined ? options.cluster?.holder(sandboxId) : undefined;

    // The hop header is the cluster's and stops here: a workspace's dev server never sees it.
    const stripHop = (request: IncomingMessage): void => {
        delete request.headers[HOP_HEADER];
    };

    // A forward that failed to even reach the peer is a holder to forget; anything else was the peer's answer.
    const forgetIfGone = (sandboxId: string, error: Error): void => {
        if (error instanceof PeerUnreachable) {
            options.cluster?.forget(sandboxId);
            options.log({ sandboxId, peer: `${error.peer.host}:${error.peer.port}` }, `peer unreachable; forgetting it as the holder`);
        }
    };

    const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
        const host = request.headers.host ?? ``;
        const sandboxId = hostOwnerId(host);
        if (sandboxId === undefined) {
            serveEdge(request, response);
            return;
        }
        const session = registry.lookup(sandboxId);
        if (session !== undefined) {
            stripHop(request);
            /* The session reports failure by rejecting, and `headersSent` is what the rejection MEANS: nothing
             * said to the browser yet, so the edge still owes it an answer; already answering, so the only
             * honest signal left is a truncated body on a reset socket. `unreachable` reads the same flag, so
             * both cases land in one call. */
            void session.forwardRequest(request, response).catch(() => unreachable(response, host));
            return;
        }
        const peer = holderFor(sandboxId, request);
        if (peer === undefined) {
            unreachable(response, host);
            return;
        }
        // The same contract as the session's: a rejection before headers is our 502, after them a reset.
        void forwardRequest(peer, request, response).catch((error: Error) => {
            forgetIfGone(sandboxId, error);
            unreachable(response, host);
        });
    };

    const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const path = (request.url ?? `/`).split(`?`)[0];
        if (path === INGRESS_TUNNEL_PATH) {
            void acceptTunnel(request, socket, head);
            return;
        }
        // A browser upgrading to a sandbox: a terminal, an agent stream, a dev server's HMR. Routed exactly
        // like a request, because it is one until the far end accepts it.
        const host = request.headers.host ?? ``;
        const sandboxId = hostOwnerId(host);
        if (sandboxId === undefined) {
            refuse(socket, 404, `Not Found`, `no sandbox is named by this address`);
            return;
        }
        const session = registry.lookup(sandboxId);
        if (session !== undefined) {
            stripHop(request);
            /* Nothing is written to the socket until the far end accepts the stream (see forwardUpgrade), so a
             * rejection leaves it untouched and this can still answer on it rather than merely resetting it. */
            void session.forwardUpgrade(request, socket, head).catch(() => refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} dropped the connection.`));
            return;
        }
        const peer = holderFor(sandboxId, request);
        if (peer === undefined) {
            refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} is not connected right now.`);
            return;
        }
        void forwardUpgrade(peer, request, socket, head).catch((error: Error) => {
            forgetIfGone(sandboxId, error);
            refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} is not connected right now.`);
        });
    };

    /* A SANDBOX ARRIVING. Two gates, in this order and for different reasons: the signature is arithmetic and
     * costs nothing, so it runs first and rejects every stranger before the platform is ever asked; the
     * existence check is a network call and only happens for a caller that has already proved who it is. */
    const acceptTunnel = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
        const header = request.headers[INGRESS_GRANT_HEADER];
        const grant = Array.isArray(header) ? header[0] : header;
        const claim = grant === undefined || grant === `` ? undefined : verifyReachabilityGrant(options.publicKey, grant);
        if (claim === undefined) {
            options.log({ remote: remoteAddressOf(socket) }, `tunnel refused: no valid reachability grant`);
            refuse(socket, 401, `Unauthorized`, `a tunnel presents a reachability grant`);
            return;
        }
        if (!(await options.revocation.allows(claim.sandboxId))) {
            options.log({ sandboxId: claim.sandboxId }, `tunnel refused: the platform says this sandbox is gone`);
            refuse(socket, 403, `Forbidden`, `that sandbox no longer exists`);
            return;
        }
        // The existence check is a round trip, and a client that gave up during it leaves a socket there is
        // nothing left to upgrade.
        if (socket.destroyed) {
            return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => void hold(claim.sandboxId, ws));
    };

    /* HOLDING A REGISTERED TUNNEL for as long as its WebSocket lives. Everything here is torn down by the one
     * `close` handler, because every way a tunnel can end — the container stopping, the heartbeat giving up,
     * displacement by a newer dial, an h2 session erroring — arrives as the socket closing. One exit means the
     * registry cannot be left holding a session whose transport is gone. */
    const hold = async (sandboxId: string, ws: WebSocket): Promise<void> => {
        const duplex = webSocketDuplex(ws);
        // A stream error is the transport failing, which is the socket's business and never this process's:
        // without a handler node raises it as an uncaught exception and takes every other sandbox with it.
        duplex.on(`error`, () => ws.terminate());
        let session: IngressSession;
        try {
            session = await openIngressSession(duplex);
        } catch (error) {
            options.log({ sandboxId, err: String(error) }, `tunnel failed to open a session`);
            ws.terminate();
            return;
        }
        const heartbeat = startHeartbeat({
            ping: () => ws.ping(),
            onDead: () => {
                options.log({ sandboxId }, `tunnel timed out: no frame within the dead window`);
                ws.terminate();
            },
            ...(options.heartbeatIntervalMs === undefined ? {} : { intervalMs: options.heartbeatIntervalMs }),
        });
        ws.on(`pong`, () => heartbeat.saw());
        // Any frame proves the peer is there. A tunnel carrying traffic is alive by definition, and demanding
        // the pong specifically would kill busy sessions over one lost control frame.
        ws.on(`message`, () => heartbeat.saw());

        const displaced = registry.register(sandboxId, { session, close: (code, reason) => ws.close(code, reason) });
        options.log({ sandboxId, displaced, tunnels: registry.size() }, `tunnel registered`);

        ws.on(`close`, () => {
            heartbeat.stop();
            registry.unregister(sandboxId, session);
            session.close();
            options.log({ sandboxId, tunnels: registry.size() }, `tunnel closed`);
        });
    };

    const server = createServer(onRequest);
    server.on(`upgrade`, onUpgrade);
    /* A malformed request head is the internet knocking, not an incident. Node's default is to destroy the
     * socket, which is right; what is not right is the unhandled 'clientError' taking the process down with
     * every tunnel on it. */
    server.on(`clientError`, (_error, socket) => socket.destroy());
    // The edge holds long-lived streams (agent turns, terminals, SSE) and must not cut them at node's default
    // two-minute head/socket timeouts. The tunnel's own heartbeat is what notices a dead peer here.
    server.headersTimeout = 0;
    server.requestTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = PING_INTERVAL_MS * 4;

    return {
        server,
        registry,
        listen: (port, host) =>
            new Promise<void>((resolve, reject) => {
                server.once(`error`, reject);
                server.listen(port, host, () => {
                    server.removeListener(`error`, reject);
                    resolve();
                });
            }),
        close: () =>
            new Promise<void>((resolve) => {
                sockets.close();
                server.close(() => resolve());
                // Registered tunnels are long-lived by construction, so a graceful close would wait forever.
                // The containers redial; that is what their loop is for.
                for (const id of registry.ids()) {
                    registry.lookup(id)?.close();
                }
            }),
    };
};
