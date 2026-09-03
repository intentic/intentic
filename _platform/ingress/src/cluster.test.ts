import type { IngressSession } from "@intentic/sandbox-contract/ingress-protocol";
import { describe, expect, test, vi } from "vitest";
import { createCluster, createInternalServer, HoldsMessageSchema, HOLDS_PATH, REMOTE_TTL_MS, type Cluster, type HoldsMessage } from "./cluster.js";
import { createStaticPeers, peerKey, type Peer, type PeerDiscovery } from "./peers.js";
import { createTunnelRegistry, DISPLACED_CODE } from "./registry.js";

const SELF: Peer = { host: `self`, port: 8080, internalPort: 8081 };
const A: Peer = { host: `peer-a`, port: 8080, internalPort: 8081 };
const B: Peer = { host: `peer-b`, port: 8080, internalPort: 8081 };
const STRANGER: Peer = { host: `stranger`, port: 8080, internalPort: 8081 };
const X = `aaaaaaaaaaaa`;
const Y = `bbbbbbbbbbbb`;

const session = (): IngressSession =>
    ({ forwardRequest: vi.fn(), forwardUpgrade: vi.fn(), close: vi.fn() }) as unknown as IngressSession;

const from = (peer: Peer, op: HoldsMessage[`op`], ids: string[]): HoldsMessage => ({ from: peer, instance: peer.host, op, ids });

// A discovery the test moves by hand, since the cluster reacts to machines coming and going.
const movablePeers = (initial: readonly Peer[]) => {
    let peers = initial;
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

/* The clock and the network are injected: `sent` is every holds message this machine put on the wire, and
 * `holdsOf` is what a peer answers when greeted. Nothing here waits on a timer. */
const world = (options: { readonly peers?: PeerDiscovery; readonly holdsOf?: (peer: string) => string[]; readonly self?: Peer } = {}) => {
    let clock = 1_000;
    const sent: { readonly url: string; readonly body: HoldsMessage }[] = [];
    // The registry reports to a cluster that does not exist yet; the closure only ever runs after it does.
    const registry = createTunnelRegistry({ onChange: (event) => cluster.onRegistryChange(event) });
    const log = vi.fn();
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const address = String(url);
        if (init?.method === `POST`) {
            sent.push({ url: address, body: HoldsMessageSchema.parse(JSON.parse(String(init.body))) });
            return Promise.resolve(new Response(`{"ok":true}`, { status: 200 }));
        }
        const host = new URL(address).hostname;
        const peer = [A, B].find((candidate) => candidate.host === host) ?? A;
        const answer: HoldsMessage = from(peer, `set`, options.holdsOf?.(host) ?? []);
        return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    });
    const cluster: Cluster = createCluster({
        instanceId: `self`,
        self: options.self ?? SELF,
        peers: options.peers ?? createStaticPeers([A, B]),
        registry,
        log,
        // SAFETY: the fake takes the two arguments the cluster passes and answers a Response; the rest of
        // fetch's overload surface is never reached.
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => clock,
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { cluster, registry, sent, log, advance: (ms: number) => (clock += ms), settle };
};

describe(`createCluster`, () => {
    test(`routes an id to the peer whose delta claimed it`, () => {
        const { cluster } = world();
        expect(cluster.holder(X)).toBeUndefined();

        cluster.receive(from(A, `add`, [X]));
        expect(cluster.holder(X)).toEqual(A);
        expect(cluster.remoteCount()).toBe(1);
    });

    // The internal port is private, and this is the second lock on it: a machine discovery has not listed
    // cannot put an entry in the map, so the map is bounded by the machine set.
    test(`ignores a peer discovery does not know`, () => {
        const { cluster, log } = world();
        cluster.receive(from(STRANGER, `add`, [X]));

        expect(cluster.holder(X)).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ from: peerKey(STRANGER) }), expect.stringContaining(`ignored`));
    });

    test(`only the holder may withdraw an id`, () => {
        const { cluster } = world();
        cluster.receive(from(A, `add`, [X]));
        cluster.receive(from(B, `remove`, [X]));
        expect(cluster.holder(X)).toEqual(A);

        cluster.receive(from(A, `remove`, [X]));
        expect(cluster.holder(X)).toBeUndefined();
    });

    /* NEWEST WINS ACROSS THE CLUSTER. The container redialled and landed on A; the session this machine still
     * holds is its corpse, and keeping it would leave two machines answering for one sandbox. */
    test(`a delta add displaces a local session for the same id`, () => {
        const { cluster, registry } = world();
        const held = session();
        const close = vi.fn();
        registry.register(X, { session: held, close });

        cluster.receive(from(A, `add`, [X]));

        expect(close).toHaveBeenCalledWith(DISPLACED_CODE, expect.stringContaining(`peer-a`));
        expect(registry.lookup(X)).toBeUndefined();
        expect(cluster.holder(X)).toEqual(A);
    });

    /* A SNAPSHOT NEVER DISPLACES. Two live sessions for one id is a token run twice, which is a
     * misconfiguration to log, not a fight to start; local routing wins, as it always did. */
    test(`a set replaces the peer's entries and leaves a local session alone`, () => {
        const { cluster, registry, log } = world();
        const close = vi.fn();
        const held = session();
        registry.register(X, { session: held, close });
        cluster.receive(from(A, `add`, [Y]));

        cluster.receive(from(A, `set`, [X]));

        expect(close).not.toHaveBeenCalled();
        expect(registry.lookup(X)).toBe(held);
        expect(cluster.holder(Y)).toBeUndefined();
        expect(cluster.holder(X)).toEqual(A);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: X }), expect.stringContaining(`also holds`));
    });

    // An entry nobody has refreshed for two sync intervals belongs to a peer that stopped talking, whether or
    // not discovery has caught up.
    test(`an entry expires when its peer stops refreshing it`, async () => {
        const { cluster, advance } = world();
        cluster.receive(from(A, `add`, [X]));
        advance(REMOTE_TTL_MS - 1);
        expect(cluster.holder(X)).toEqual(A);

        advance(2);
        expect(cluster.holder(X)).toBeUndefined();

        cluster.receive(from(A, `add`, [Y]));
        advance(REMOTE_TTL_MS + 1);
        await cluster.tick();
        expect(cluster.remoteCount()).toBe(0);
    });

    test(`forget drops an entry a forward found to be wrong`, () => {
        const { cluster } = world();
        cluster.receive(from(A, `add`, [X]));
        cluster.forget(X);
        expect(cluster.holder(X)).toBeUndefined();
    });

    test(`tells every peer about a local arrival and departure`, () => {
        const { registry, sent } = world();
        sent.length = 0;
        const held = session();
        registry.register(X, { session: held, close: vi.fn() });
        registry.unregister(X, held);

        expect(sent.map((message) => [new URL(message.url).hostname, message.body.op, message.body.ids])).toEqual([
            [`peer-a`, `add`, [X]],
            [`peer-b`, `add`, [X]],
            [`peer-a`, `remove`, [X]],
            [`peer-b`, `remove`, [X]],
        ]);
        expect(sent[0]?.body.from).toEqual(SELF);
        expect(sent[0]?.url).toBe(`http://peer-a:8081${HOLDS_PATH}`);
    });

    test(`a tick pushes the full held-id list to every peer`, async () => {
        const { cluster, registry, sent } = world();
        registry.register(X, { session: session(), close: vi.fn() });
        registry.register(Y, { session: session(), close: vi.fn() });
        sent.length = 0;

        await cluster.tick();

        expect(sent.map((message) => [new URL(message.url).hostname, message.body.op, [...message.body.ids].sort()])).toEqual([
            [`peer-a`, `set`, [X, Y]],
            [`peer-b`, `set`, [X, Y]],
        ]);
    });

    /* GREETING. A machine that has just come up asks every peer what it holds and tells them what it holds,
     * so nobody waits out a sync interval to be useful. */
    test(`greets the peers it starts with: pulls their holds, pushes its own`, async () => {
        const { cluster, sent, settle } = world({ holdsOf: (peer) => (peer === `peer-a` ? [X] : [Y]) });
        await settle();

        expect(cluster.holder(X)).toEqual(A);
        expect(cluster.holder(Y)).toEqual(B);
        expect(sent.map((message) => [new URL(message.url).hostname, message.body.op])).toEqual([
            [`peer-a`, `set`],
            [`peer-b`, `set`],
        ]);
    });

    test(`greets a machine discovery adds, and drops the entries of one it removes`, async () => {
        const { discovery, move } = movablePeers([A]);
        const { cluster, sent, settle } = world({ peers: discovery, holdsOf: (peer) => (peer === `peer-b` ? [Y] : []) });
        await settle();
        cluster.receive(from(A, `add`, [X]));
        sent.length = 0;

        move([A, B]);
        await settle();
        expect(cluster.holder(Y)).toEqual(B);
        expect(sent.map((message) => new URL(message.url).hostname)).toEqual([`peer-b`]);

        move([B]);
        expect(cluster.holder(X)).toBeUndefined();
        expect(cluster.holder(Y)).toEqual(B);
    });

    // Off Fly with no advertised address, a machine can still route and forward; it just cannot tell anyone
    // what it holds, and main.ts says so at boot.
    test(`a machine with no address of its own receives but never advertises`, () => {
        const { cluster, registry, sent } = world({ self: { ...SELF, host: `` } });
        registry.register(X, { session: session(), close: vi.fn() });
        cluster.receive(from(A, `add`, [Y]));

        expect(sent).toEqual([]);
        expect(cluster.holder(Y)).toEqual(A);
    });

    test(`says and hears nothing after close`, async () => {
        const { cluster, registry, sent } = world();
        cluster.receive(from(A, `add`, [X]));
        cluster.close();
        sent.length = 0;
        registry.register(Y, { session: session(), close: vi.fn() });
        await cluster.tick();

        expect(cluster.holder(X)).toBeUndefined();
        expect(sent).toEqual([]);
    });
});

describe(`the internal surface`, () => {
    const serve = async () => {
        const registry = createTunnelRegistry();
        registry.register(X, { session: session(), close: vi.fn() });
        const receive = vi.fn();
        // SAFETY: the surface calls exactly `receive` on the cluster; the rest is never touched here.
        const cluster = { receive } as unknown as Cluster;
        const server = createInternalServer({ cluster, registry, self: SELF, instanceId: `self` });
        await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
        const address = server.address();
        const port = address !== null && typeof address === `object` ? address.port : 0;
        const base = `http://127.0.0.1:${port}`;
        return { base, receive, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    };

    test(`GET answers what this machine holds, as a set from itself`, async () => {
        const { base, close } = await serve();
        const answer = await fetch(`${base}${HOLDS_PATH}`);
        expect(answer.status).toBe(200);
        expect(HoldsMessageSchema.parse(await answer.json())).toEqual({ from: SELF, instance: `self`, op: `set`, ids: [X] });
        await close();
    });

    test(`POST hands a well-formed message to the cluster and refuses anything else`, async () => {
        const { base, receive, close } = await serve();
        const post = (body: string) => fetch(`${base}${HOLDS_PATH}`, { method: `POST`, headers: { "content-type": `application/json` }, body });

        expect((await post(JSON.stringify(from(A, `add`, [Y])))).status).toBe(200);
        expect(receive).toHaveBeenCalledWith(from(A, `add`, [Y]));
        expect((await post(`not json`)).status).toBe(400);
        expect((await post(JSON.stringify({ op: `add` }))).status).toBe(400);
        expect((await post(JSON.stringify(from(A, `add`, [`not-an-id`])))).status).toBe(400);
        expect((await fetch(`${base}${HOLDS_PATH}`, { method: `PUT` })).status).toBe(405);
        expect((await fetch(`${base}/tunnel/v1`)).status).toBe(404);
        expect((await fetch(`${base}/health`)).status).toBe(200);
        await close();
    });
});
