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
 *   • everything else is a BROWSER, routed to a registered tunnel by the Host header's own sandbox id — or,
 *     for a sandbox the platform runs on Fly, answered with a REPLAY that sends Fly's proxy to that
 *     sandbox's own app, so the bytes never come through here at all
 *
 * TWO LANES, ONE HOSTNAME SHAPE. A sandbox on somebody's own machine can only be reached through a tunnel it
 * dials, so for it this process IS the data path. A hosted sandbox is a Fly app in the same org, already on
 * the internet, and dials nothing: the edge's whole job for it is one routing decision. `fly-replay: app=…`
 * tells Fly's proxy to deliver this request to that app (across private networks, with no public address on
 * the target), and `fly-replay-cache` tells it to keep doing so for every request on this hostname for a
 * while without asking again — so in the steady state a hosted sandbox's traffic is browser → Fly → machine
 * and this process sees one request per hostname per cache TTL. The app is named after the id in the
 * hostname (`<prefix>-<id>`, hosted-pool.ts on the platform makes that true of pool-born machines too), so
 * the decision needs no state here and, when the platform cannot be asked, no platform either.
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
    /* The app-name prefix of the platform's hosted sandboxes (`<prefix>-<id>`), which is also the switch:
     * absent ⇒ no request is ever replayed, and a sandbox with no tunnel is simply not connected. Present ⇒
     * a hostname no tunnel holds is replayed to that app unless the platform says the sandbox is a
     * tunnel-lane one (revocation.ts lookup). */
    readonly hostedAppPrefix?: string;
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

/* A response on a HIJACKED socket. Once an upgrade has been taken off the server, node will never write a
 * response for us, so anything said on it has to be a hand-written HTTP/1.1 head or the client waits for a
 * timeout with no idea why. `Connection: close` because there is no keep-alive to return to on a socket we
 * are done with. */
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

// ── The replay ──────────────────────────────────────────────────────────────────────────────────────────

/* How long Fly's proxy keeps sending a hostname's requests to the app this edge named, without asking again.
 * Long enough that the edge is off the path of everything a person does in one sitting; short enough that a
 * sandbox destroyed and re-made (hostedRestart on the platform builds a replacement under the same app name,
 * so even that is not a move) is followed within minutes rather than hours. Fly's floor is ten seconds. */
export const REPLAY_CACHE_TTL_SECS = 300;

/* The three headers that make Fly's proxy carry a request elsewhere: the target app; the pattern of
 * requests the decision covers, spelled with the hostname so it never leaks onto another sandbox's name (the
 * cache is keyed on the Host header, fly.toml); and for how long. Read by Fly's proxy and stripped: nothing
 * downstream sees them. */
export const replayHeaders = (host: string, app: string): Readonly<Record<string, string>> => ({
    "fly-replay": `app=${app}`,
    "fly-replay-cache": `${host.split(`:`)[0] ?? host}/*`,
    "fly-replay-cache-ttl-secs": String(REPLAY_CACHE_TTL_SECS),
});

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
                    // Whether hosted sandboxes are replayed to their apps here, the one config fact a
                    // deployment can get wrong without any tunnel looking different.
                    replay: options.hostedAppPrefix !== undefined,
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

    /* WHERE A SANDBOX NOBODY HOLDS MAY BE SENT INSTEAD: the Fly app of a hosted sandbox, or nowhere.
     *
     * The platform is asked (cached) which lane the id is on. `tunnel` is definite: the box dials the edge
     * and is simply not here, so the answer is the 502 the browser's wake flow already reads. `hosted` is a
     * replay, to the app the platform named or, failing that, the one the naming rule implies. A platform
     * that cannot be asked leaves the lane unknown, and unknown REPLAYS: a wrong replay costs the browser one
     * proxy error for a sandbox that was unreachable anyway, a wrong refusal costs a working hosted sandbox
     * its whole outage — the same fail-open the registration check makes, for the same reason.
     *
     * A request another machine already handed us is never replayed: the peer believed we held the tunnel,
     * and the only honest answer to a belief that was wrong is the 502 that lets it forget. */
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
            /* The session reports failure by rejecting, and `headersSent` is what the rejection MEANS: nothing
             * said to the browser yet, so the edge still owes it an answer; already answering, so the only
             * honest signal left is a truncated body on a reset socket. `unreachable` reads the same flag, so
             * both cases land in one call. */
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
                // The head is the whole answer: Fly's proxy reads the headers and replays the request it
                // already holds, body and all. Nothing of this response reaches the browser.
                options.log({ sandboxId, app }, `replaying to the sandbox's app`);
                response.writeHead(200, { ...replayHeaders(host, app), "content-length": `0` });
                response.end();
            });
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
                /* An upgrade is replayed by NOT upgrading: Fly's rule is that the app answering with the
                 * replay headers must not negotiate the WebSocket itself, the target does. So the answer is
                 * a plain head with the headers on it, and the 101 comes from the sandbox. */
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
