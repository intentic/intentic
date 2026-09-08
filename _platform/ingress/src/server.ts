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

// One HTTP server, two jobs on one port, decided before anything else: an upgrade to INGRESS_TUNNEL_PATH is a sandbox
// registering; everything else is a browser, routed by Host to a registered tunnel, or replayed via Fly for a hosted
// sandbox with no tunnel to dial.
// The tunnel door is checked by path, never by host, since the edge's own hostname carries no sandbox id; routing reads
// the Host per request, never per connection, since h2 coalesces many hostnames onto one TLS connection.
// Holds nothing durable: the registry is a Map, so a restart is just every container's reconnect loop; several of these
// behind one address forward a local miss to the machine that holds it (cluster.ts), once.

export interface IngressServerOptions {
    // Platform's Ed25519 public key (SPKI PEM); the edge verifies grants and can never mint one.
    readonly publicKey: string;
    readonly revocation: Revocation;
    readonly log: (event: Record<string, unknown>, message: string) => void;
    readonly registry?: TunnelRegistry;
    // Where a locally-unknown sandbox may be found; absent means one machine, and a miss is a 502.
    readonly cluster?: Cluster;
    // For /health only: how many machines this one knows of.
    readonly peers?: PeerDiscovery;
    readonly instanceId?: string;
    readonly heartbeatIntervalMs?: number;
    // App-name prefix for hosted sandboxes (`<prefix>-<id>`); absent disables replay.
    readonly hostedAppPrefix?: string;
}

export interface IngressServer {
    readonly server: Server;
    readonly registry: TunnelRegistry;
    readonly listen: (port: number, host: string) => Promise<void>;
    readonly close: () => Promise<void>;
}

// Leftmost DNS label, the address a person recognizes; used in a 502's body instead of the bare id.
const labelOf = (host: string): string => host.split(`:`)[0]?.split(`.`)[0] ?? host;

// Peer address for a refusal log line; a `Duplex` isn't guaranteed to be a `Socket` behind a TLS terminator.
// Asked rather than asserted, since an address is only a nicety in the message.
const remoteAddressOf = (socket: Duplex): string | undefined => (socket instanceof Socket ? socket.remoteAddress : undefined);

// Writes a hand-written HTTP/1.1 response on a hijacked socket, since node won't write one after an upgrade leaves the
// server.
// `Connection: close`, since there's no keep-alive to return to.
const answer = (socket: Duplex, status: number, reason: string, headers: Readonly<Record<string, string>>, body: string): void => {
    if (socket.destroyed) {
        return;
    }
    const payload = Buffer.from(body === `` ? `` : `${body}\n`, `utf8`);
    const lines = Object.entries({
        "Content-Type": `text/plain; charset=utf-8`,
        ...headers,
        "Content-Length": String(payload.length),
        Connection: `close`,
    }).map(([name, value]) => `${name}: ${value}`);
    socket.end(`HTTP/1.1 ${status} ${reason}\r\n${lines.join(`\r\n`)}\r\n\r\n${payload.toString(`utf8`)}`);
};

const refuse = (socket: Duplex, status: number, reason: string, body: string): void => answer(socket, status, reason, {}, body);

// The replay.

// How long Fly's proxy reuses the replay decision per hostname before asking again; Fly's floor is ten seconds.
export const REPLAY_CACHE_TTL_SECS = 300;

// The three headers that make Fly's proxy carry a request elsewhere: the target app, the hostname pattern the decision
// covers, and the TTL.
// Read and stripped by Fly's proxy; nothing downstream sees them.
export const replayHeaders = (host: string, app: string): Readonly<Record<string, string>> => ({
    "fly-replay": `app=${app}`,
    "fly-replay-cache": `${host.split(`:`)[0] ?? host}/*`,
    "fly-replay-cache-ttl-secs": String(REPLAY_CACHE_TTL_SECS),
});

// 502, not 404: the browser's availability flow reads any 5xx as unreachable and wakes it, while 404 stops it.
// Names the label in the body, since this is the one edge error a person actually meets.
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
    // noServer: this server handles its own upgrades, telling the tunnel door apart from a sandbox socket by path.
    const sockets = new WebSocketServer({ noServer: true });

    // What answers on a host naming no sandbox: `/health` for a load balancer, else a 404 stray subdomain.
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
                    // Whether hosted sandboxes are replayed here; a deployment fact easy to get wrong invisibly.
                    replay: options.hostedAppPrefix !== undefined,
                }),
            );
            return;
        }
        if (path === INGRESS_TUNNEL_PATH) {
            // Door exists but isn't a websocket: 426, not 404, so a misconfigured client doesn't look like a wrong
            // address.
            response.writeHead(426, { "content-type": `text/plain; charset=utf-8`, upgrade: `websocket` });
            response.end(`the tunnel door takes a websocket upgrade\n`);
            return;
        }
        response.writeHead(404, { "content-type": `text/plain; charset=utf-8` });
        response.end(`no sandbox is named by this address\n`);
    };

    // A hop-marked request already failed here once; no further holder is looked up, so a miss on it is final.
    // A browser's own request instead asks the cluster, which may name the holder or answer nothing.
    const holderFor = (sandboxId: string, request: IncomingMessage) =>
        request.headers[HOP_HEADER] === undefined ? options.cluster?.holder(sandboxId) : undefined;

    // Hop header is internal to the cluster; a workspace's dev server must never see it.
    const stripHop = (request: IncomingMessage): void => {
        delete request.headers[HOP_HEADER];
    };

    // A forward that never reached the peer means forgetting it as holder; anything else was the peer's own answer.
    const forgetIfGone = (sandboxId: string, error: Error): void => {
        if (error instanceof PeerUnreachable) {
            options.cluster?.forget(sandboxId);
            options.log({ sandboxId, peer: `${error.peer.host}:${error.peer.port}` }, `peer unreachable; forgetting it as the holder`);
        }
    };

    // Looks up which Fly app to replay to: `tunnel`, or an already-forwarded request, replays nowhere; `hosted` replays
    // to the named or implied app; an unknown lane fails open to a replay.
    // A hop-marked request is never replayed, since the peer that forwarded it already believed the tunnel was here.
    const replayTarget = async (sandboxId: string, request: IncomingMessage): Promise<string | undefined> => {
        if (options.hostedAppPrefix === undefined || request.headers[HOP_HEADER] !== undefined) {
            return undefined;
        }
        const reachability = await options.revocation.lookup(sandboxId);
        if (!reachability.exists || reachability.lane === `tunnel`) {
            return undefined;
        }
        return reachability.app ?? `${options.hostedAppPrefix}-${sandboxId}`;
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
            // `headersSent` is what a rejection means: unset owes the browser an answer still, set means only a reset
            // is left.
            // `unreachable` reads the same flag, so both cases share one call.
            void session.forwardRequest(request, response).catch(() => unreachable(response, host));
            return;
        }
        const peer = holderFor(sandboxId, request);
        if (peer === undefined) {
            void replayTarget(sandboxId, request).then((app) => {
                if (app === undefined) {
                    unreachable(response, host);
                    return;
                }
                // The head is the whole answer: Fly's proxy replays the request it holds; nothing here reaches the
                // browser.
                options.log({ sandboxId, app }, `replaying to the sandbox's app`);
                response.writeHead(200, { ...replayHeaders(host, app), "content-length": `0` });
                response.end();
            });
            return;
        }
        // Same contract as a session's: a rejection before headers is our 502, after them a reset.
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
        // A browser upgrading to a sandbox (terminal, agent stream, HMR), routed like a request until accepted.
        const host = request.headers.host ?? ``;
        const sandboxId = hostOwnerId(host);
        if (sandboxId === undefined) {
            refuse(socket, 404, `Not Found`, `no sandbox is named by this address`);
            return;
        }
        const session = registry.lookup(sandboxId);
        if (session !== undefined) {
            stripHop(request);
            // Nothing is written until the far end accepts, so a rejection can still be answered, not just reset.
            void session
                .forwardUpgrade(request, socket, head)
                .catch(() => refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} dropped the connection.`));
            return;
        }
        const peer = holderFor(sandboxId, request);
        if (peer === undefined) {
            void replayTarget(sandboxId, request).then((app) => {
                if (app === undefined) {
                    refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} is not connected right now.`);
                    return;
                }
                // Replayed by not upgrading: the app answering with replay headers must not negotiate the WebSocket
                // itself.
                // A plain head carries the headers; the 101 comes from the sandbox.
                options.log({ sandboxId, app }, `replaying an upgrade to the sandbox's app`);
                answer(socket, 200, `OK`, replayHeaders(host, app), ``);
            });
            return;
        }
        void forwardUpgrade(peer, request, socket, head).catch((error: Error) => {
            forgetIfGone(sandboxId, error);
            refuse(socket, 502, `Bad Gateway`, `${labelOf(host)} is not connected right now.`);
        });
    };

    // Two gates in order: the signature check is free and rejects a stranger before the platform is ever asked.
    // The existence check is a network call, run only for a caller that already proved who it is.
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
        // The existence check is a round trip; a client that gave up during it leaves nothing left to upgrade.
        if (socket.destroyed) {
            return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) => void hold(claim.sandboxId, ws));
    };

    // Holds a registered tunnel as long as its WebSocket lives; every way it can end (stop, dead heartbeat,
    // displacement, error) arrives as the socket closing.
    // One `close` handler tears everything down, so the registry can't be left holding a dead session.
    const hold = async (sandboxId: string, ws: WebSocket): Promise<void> => {
        const duplex = webSocketDuplex(ws);
        // Unhandled, a stream error becomes an uncaught exception that takes every other sandbox down with it.
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
        // Any frame proves the peer is alive; requiring the pong alone would kill a busy session over one lost frame.
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
    // A malformed request head is the internet knocking, not an incident; node's default (destroy the socket) is right.
    // Left unhandled, `clientError` would take the whole process down with every tunnel on it.
    server.on(`clientError`, (_error, socket) => socket.destroy());
    // Long-lived streams must survive node's default two-minute timeouts; the heartbeat alone catches a dead peer.
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
                // A tunnel is long-lived by construction; closing gracefully would wait forever, so containers redial
                // instead.
                for (const id of registry.ids()) {
                    registry.lookup(id)?.close();
                }
            }),
    };
};
