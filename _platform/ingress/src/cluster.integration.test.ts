import { INGRESS_GRANT_HEADER, mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { serveIngressSession, type IngressSessionServer } from "@intentic/sandbox-contract/ingress-protocol";
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as h1Request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWebSocketStream, WebSocket } from "ws";
import { createCluster, createInternalServer, HOP_HEADER, type Cluster } from "./cluster.js";
import type { Peer, PeerDiscovery } from "./peers.js";
import { createTunnelRegistry, DISPLACED_CODE } from "./registry.js";
import { createIngressServer, type IngressServer } from "./server.js";

/* TWO MACHINES, ONE SANDBOX, THE WRONG ONE ASKED. This is the situation the cluster exists for, run on real
 * sockets: a container dials machine A, a browser arrives at machine B, and the request has to come out of the
 * container's front door with its Host intact — then an upgrade, then the container moving to B and A learning
 * it, then the two ways a forward can fail and what the browser sees for each. Everything between A and B is
 * the real holds protocol over real HTTP; nothing is faked but the clock nobody waits on. */

const ZONE = `sbx.example.test`;
const SANDBOX_ID = `abcdef012345`;
const NOBODY_ID = `0123456789ab`;
const GHOST_ID = `feedfacecafe`;

const keys = generateKeyPairSync(`ed25519`);
const privateKey = keys.privateKey.export({ type: `pkcs8`, format: `pem` }).toString();
const publicKey = keys.publicKey.export({ type: `spki`, format: `pem` }).toString();

const portOf = (server: Server): number => (server.address() as AddressInfo).port;
const listen = (server: Server): Promise<void> => new Promise((resolve) => server.listen(0, `127.0.0.1`, resolve));
const closeServer = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

// Bounded, not a sleep: polls until the cluster has learned what a peer just told it, or fails by name.
const waitFor = async (what: string, condition: () => boolean, deadlineMs = 3_000): Promise<void> => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > deadlineMs) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
};

const get = (port: number, host: string, path = `/`, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = h1Request({ host: `127.0.0.1`, port, path, headers: { host, ...headers } }, (response) => {
            const chunks: Buffer[] = [];
            response.on(`data`, (chunk: Buffer) => chunks.push(chunk));
            response.on(`end`, () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(`utf8`) }));
        });
        request.on(`error`, reject);
        request.end();
    });

// A discovery the test moves by hand: both machines start alone, then are introduced, then one meets a ghost.
const movable = () => {
    let peers: readonly Peer[] = [];
    const listeners = new Set<(next: readonly Peer[]) => void>();
    const discovery: PeerDiscovery = {
        current: () => peers,
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: () => listeners.clear(),
    };
    return {
        discovery,
        move: (next: readonly Peer[]) => {
            peers = next;
            for (const listener of listeners) {
                listener(peers);
            }
        },
    };
};

interface Machine {
    readonly name: string;
    readonly edge: IngressServer;
    readonly cluster: Cluster;
    readonly internal: Server;
    readonly self: Peer;
    readonly move: (peers: readonly Peer[]) => void;
    readonly close: () => Promise<void>;
}

const machine = async (name: string): Promise<Machine> => {
    const { discovery, move } = movable();
    const registry = createTunnelRegistry({ onChange: (event) => cluster.onRegistryChange(event) });
    const self: Peer = { host: `127.0.0.1`, port: 0, internalPort: 0 };
    const cluster: Cluster = createCluster({
        instanceId: name,
        // Ports are filled in below once the listeners have them; the cluster reads `self` by reference.
        self,
        peers: discovery,
        registry,
        log: () => undefined,
    });
    const internal = createInternalServer({ cluster, registry, self, instanceId: name });
    await listen(internal);
    const edge = createIngressServer({
        publicKey,
        revocation: { allows: () => Promise.resolve(true), lookup: () => Promise.resolve({ exists: true, lane: `tunnel` }) },
        log: () => undefined,
        registry,
        cluster,
        peers: discovery,
        instanceId: name,
    });
    await edge.listen(0, `127.0.0.1`);
    // SAFETY: `self` was declared mutable in effect by these two writes only, before anyone reads it.
    (self as { port: number }).port = portOf(edge.server);
    (self as { internalPort: number }).internalPort = portOf(internal);
    return {
        name,
        edge,
        cluster,
        internal,
        self,
        move,
        close: async () => {
            cluster.close();
            discovery.close();
            await edge.close();
            await closeServer(internal);
        },
    };
};

// A container's front door: answers with the Host and the headers it saw, and echoes an upgrade.
const frontDoor = async (): Promise<{ readonly server: Server; readonly seen: () => IncomingHttpHeaders | undefined }> => {
    let headers: IncomingHttpHeaders | undefined;
    const server = createServer((request, response) => {
        headers = request.headers;
        response.writeHead(200, { "content-type": `text/plain` });
        response.end(`served ${request.headers.host}${request.url}`);
    });
    server.on(`upgrade`, (request, socket: Socket) => {
        headers = request.headers;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
        socket.pipe(socket);
    });
    await listen(server);
    return { server, seen: () => headers };
};

// A container dialling a machine, the way the daemon does.
const dial = async (
    edge: IngressServer,
    targetPort: number,
): Promise<{ socket: WebSocket; daemon: IngressSessionServer; closedWith: Promise<number> }> => {
    const grant = mintReachabilityGrant(privateKey, SANDBOX_ID, Date.now());
    const socket = new WebSocket(`ws://127.0.0.1:${portOf(edge.server)}/tunnel/v1`, { headers: { [INGRESS_GRANT_HEADER]: grant } });
    const closedWith = new Promise<number>((resolve) => socket.on(`close`, (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
        socket.on(`open`, () => resolve());
        socket.on(`error`, reject);
    });
    const daemon = await serveIngressSession(createWebSocketStream(socket), { targetPort });
    await waitFor(`the tunnel to register`, () => edge.registry.ids().includes(SANDBOX_ID));
    return { socket, daemon, closedWith };
};

describe(`two machines behind one address`, () => {
    let a: Machine;
    let b: Machine;
    let door: Awaited<ReturnType<typeof frontDoor>>;
    let first: Awaited<ReturnType<typeof dial>>;
    let second: Awaited<ReturnType<typeof dial>> | undefined;

    beforeAll(async () => {
        [a, b, door] = await Promise.all([machine(`a`), machine(`b`), frontDoor()]);
        a.move([b.self]);
        b.move([a.self]);
        first = await dial(a.edge, portOf(door.server));
    });

    afterAll(async () => {
        second?.daemon.close();
        second?.socket.terminate();
        first.daemon.close();
        first.socket.terminate();
        await Promise.all([a.close(), b.close(), closeServer(door.server)]);
    });

    test(`the machine the container did not dial learns who holds it`, async () => {
        await waitFor(`b to learn the holder`, () => b.cluster.holder(SANDBOX_ID) !== undefined);
        expect(b.cluster.holder(SANDBOX_ID)).toEqual(a.self);
        expect(a.edge.registry.ids()).toEqual([SANDBOX_ID]);
        expect(b.edge.registry.ids()).toEqual([]);
    });

    /* THE CASE THE CLUSTER EXISTS FOR. The browser is on b, the tunnel is on a, and the request comes out of
     * the container's front door with its Host intact and the hop header stripped. */
    test(`a request to the wrong machine is served by the right one, Host intact, hop stripped`, async () => {
        const answer = await get(portOf(b.edge.server), `sandbox-${SANDBOX_ID}.${ZONE}`, `/health`);
        expect(answer).toEqual({ status: 200, body: `served sandbox-${SANDBOX_ID}.${ZONE}/health` });
        expect(door.seen()?.[HOP_HEADER]).toBeUndefined();
        expect(door.seen()?.[`x-forwarded-for`]).toBe(`127.0.0.1`);
    });

    test(`a preview hostname forwards the same way`, async () => {
        const answer = await get(portOf(b.edge.server), `preview-web-${SANDBOX_ID}.${ZONE}`, `/`);
        expect(answer.body).toBe(`served preview-web-${SANDBOX_ID}.${ZONE}/`);
    });

    test(`an upgrade to the wrong machine is spliced through to the container`, async () => {
        const echoed = await new Promise<string>((resolve, reject) => {
            const request = h1Request({
                host: `127.0.0.1`,
                port: portOf(b.edge.server),
                path: `/ws`,
                headers: { host: `sandbox-${SANDBOX_ID}.${ZONE}`, connection: `Upgrade`, upgrade: `echo` },
            });
            request.on(`upgrade`, (response, socket: Socket) => {
                expect(response.statusCode).toBe(101);
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
        expect(door.seen()?.[HOP_HEADER]).toBeUndefined();
    });

    test(`/health on each machine says what it holds and what it forwards`, async () => {
        const healthA = JSON.parse((await get(portOf(a.edge.server), `ingress.${ZONE}`, `/health`)).body);
        const healthB = JSON.parse((await get(portOf(b.edge.server), `ingress.${ZONE}`, `/health`)).body);
        expect(healthA).toMatchObject({ instance: `a`, tunnels: 1, peers: 1, remote: 0 });
        expect(healthB).toMatchObject({ instance: `b`, tunnels: 0, peers: 1, remote: 1 });
    });

    // AT MOST ONE HOP. A request a peer handed over that misses here is the peer's mistake to correct, and
    // forwarding it again is how a loop would start.
    test(`a hop-marked request that misses is a 502, never forwarded again`, async () => {
        b.cluster.receive({ from: a.self, instance: `a`, op: `add`, ids: [NOBODY_ID] });
        const answer = await get(portOf(b.edge.server), `sandbox-${NOBODY_ID}.${ZONE}`, `/`, { [HOP_HEADER]: `1` });
        expect(answer.status).toBe(502);
        expect(answer.body).toContain(`sandbox-${NOBODY_ID}`);
    });

    /* A HOLDER THAT WAS WRONG. b believes a holds NOBODY; a does not. The forward reaches a, a answers its own
     * 502 on the hop-marked request, and b relays it — a readable answer, not a hang — and keeps the entry,
     * since the peer was there and simply said no. */
    test(`a stale holder answers 502 through the peer, and stays until a peer says otherwise`, async () => {
        const answer = await get(portOf(b.edge.server), `sandbox-${NOBODY_ID}.${ZONE}`, `/`);
        expect(answer.status).toBe(502);
        expect(b.cluster.holder(NOBODY_ID)).toEqual(a.self);
    });

    // A HOLDER THAT IS GONE. The machine b was told holds GHOST is not listening; the browser gets 502 and b
    // forgets the holder rather than trying it on every request until the entry expires.
    test(`an unreachable holder is a 502 and is forgotten`, async () => {
        const ghost: Peer = { host: `127.0.0.1`, port: 1, internalPort: 1 };
        b.move([a.self, ghost]);
        b.cluster.receive({ from: ghost, instance: `ghost`, op: `add`, ids: [GHOST_ID] });
        expect(b.cluster.holder(GHOST_ID)).toEqual(ghost);

        const answer = await get(portOf(b.edge.server), `sandbox-${GHOST_ID}.${ZONE}`, `/`);
        expect(answer.status).toBe(502);
        expect(b.cluster.holder(GHOST_ID)).toBeUndefined();
        b.move([a.self]);
    });

    /* THE CONTAINER MOVES. It redials and lands on b this time. b registers it, tells a, and a closes the
     * session it still held with the displacement code — so the old socket knows it was replaced rather than
     * dropped — and from then on a forwards to b. Newest wins, on whichever machine it landed. */
    test(`a redial that lands on the other machine displaces the first, and the first machine forwards`, async () => {
        second = await dial(b.edge, portOf(door.server));
        expect(await first.closedWith).toBe(DISPLACED_CODE);
        await waitFor(`a to forward to b`, () => a.edge.registry.ids().length === 0 && a.cluster.holder(SANDBOX_ID) !== undefined);
        expect(a.cluster.holder(SANDBOX_ID)).toEqual(b.self);

        const answer = await get(portOf(a.edge.server), `sandbox-${SANDBOX_ID}.${ZONE}`, `/moved`);
        expect(answer).toEqual({ status: 200, body: `served sandbox-${SANDBOX_ID}.${ZONE}/moved` });
    });
});
