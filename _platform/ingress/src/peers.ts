import { promises as dns } from "node:dns";

/* WHO ELSE IS THIS EDGE, the question every other file in the cluster leans on and none of them answers.
 *
 * A peer is an address and two ports: the public one, where a forwarded request goes so the peer routes it by
 * Host exactly like one that arrived from the internet (forward.ts), and the internal one, where the holds
 * protocol lives (cluster.ts). Two sources produce the list and both hand back the same shape, so nothing
 * downstream knows which it is running on:
 *
 *   • A STATIC LIST, for a deployment that is not on Fly and for tests. Parsed once; never changes.
 *   • FLY'S INTERNAL DNS, for the deployment that actually runs this. `<app>.internal` answers an AAAA record
 *     per machine, so the list IS the app's machine set, and polling it is how a machine added by `fly scale`
 *     is known to every other within one interval and a machine that was stopped drops out within one too —
 *     which is what lets cluster.ts drop a vanished peer's holdings instead of waiting them out.
 *
 * SELF-EXCLUSION IS BY ADDRESS, not by id: the DNS answer carries addresses and nothing else, and the address
 * this instance was given (FLY_PRIVATE_IP) is the one fact it can match against that answer. A static list is
 * assumed not to name its own host.
 *
 * Split into a refresh and a clock the way heartbeat.ts is, so the tests drive `refresh()` against an injected
 * resolver rather than waiting out real seconds. */

export interface Peer {
    readonly host: string;
    readonly port: number;
    readonly internalPort: number;
}

export interface PeerDiscovery {
    readonly current: () => readonly Peer[];
    // Fires with the full new list whenever it differs from the last one. Returns the unsubscribe.
    readonly onChange: (listener: (peers: readonly Peer[]) => void) => () => void;
    readonly close: () => void;
}

// How often Fly's DNS is asked. Short, because it bounds how long a request can be forwarded to a machine
// that is gone and how long a new machine goes unknown; cheap, because the answer is one local lookup.
export const FLY_POLL_INTERVAL_MS = 10_000;

// The peer's identity for map keys and change detection: the address and both ports, since two entries
// naming one host on different ports are two peers (which is exactly what a loopback test runs).
export const peerKey = (peer: Peer): string => `${peer.host}|${peer.port}|${peer.internalPort}`;

const sameList = (a: readonly Peer[], b: readonly Peer[]): boolean =>
    a.length === b.length && a.every((peer, index) => peerKey(peer) === peerKey(b[index] ?? peer));

const bySortedKey = (peers: readonly Peer[]): readonly Peer[] => [...peers].sort((a, b) => peerKey(a).localeCompare(peerKey(b)));

/* Parse `host[:port[:internalPort]]`. An IPv6 literal is bracketed, `[fdaa::1]:8080:8081`, since its own
 * colons would otherwise be read as ports. Malformed entries are refused rather than skipped: a peer list with
 * a typo in it is a cluster that silently forwards to nobody, and the boot log is where that should surface. */
export const parsePeerList = (list: string, defaults: { readonly port: number; readonly internalPort: number }): readonly Peer[] => {
    const entries = list
        .split(`,`)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ``);
    return entries.map((entry) => {
        const bracketed = /^\[([^\]]+)\](?::(\d+))?(?::(\d+))?$/u.exec(entry);
        const plain = bracketed === null ? /^([^:]+)(?::(\d+))?(?::(\d+))?$/u.exec(entry) : null;
        const match = bracketed ?? plain;
        if (match === null) {
            throw new Error(`INGRESS_PEERS entry "${entry}" is not host[:port[:internalPort]]`);
        }
        const [, host, port, internalPort] = match;
        // SAFETY: both patterns make the host group mandatory, so a match always captured it.
        const hostName = host as string;
        return {
            host: hostName,
            port: port === undefined ? defaults.port : Number(port),
            internalPort: internalPort === undefined ? defaults.internalPort : Number(internalPort),
        };
    });
};

// A list that is what it was told and nothing else. `close` and `onChange` exist so the shape is one shape.
export const createStaticPeers = (peers: readonly Peer[]): PeerDiscovery => {
    const fixed = bySortedKey(peers);
    return {
        current: () => fixed,
        onChange: () => () => undefined,
        close: () => undefined,
    };
};

export interface FlyPeersOptions {
    readonly appName: string;
    // This instance's own private address, excluded from the answer.
    readonly selfAddress: string;
    readonly port: number;
    readonly internalPort: number;
    readonly resolve?: (hostname: string) => Promise<readonly string[]>;
    readonly log?: (message: string, error?: Error) => void;
}

export interface FlyPeers extends PeerDiscovery {
    // One poll: ask DNS, and tell the listeners if the machine set moved.
    readonly refresh: () => Promise<void>;
}

export const createFlyPeers = (options: FlyPeersOptions): FlyPeers => {
    const resolve = options.resolve ?? ((hostname: string) => dns.resolve6(hostname));
    const listeners = new Set<(peers: readonly Peer[]) => void>();
    let peers: readonly Peer[] = [];
    let closed = false;

    return {
        current: () => peers,
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh: async () => {
            if (closed) {
                return;
            }
            let addresses: readonly string[];
            try {
                addresses = await resolve(`${options.appName}.internal`);
            } catch (error) {
                /* A failed lookup is not an empty app. Keeping the last answer means a DNS blip cannot make
                 * every machine forget every other and 502 the requests it was forwarding a second ago. */
                options.log?.(`peer discovery: ${options.appName}.internal did not resolve; keeping the last answer`, error instanceof Error ? error : undefined);
                return;
            }
            const next = bySortedKey(
                addresses
                    .filter((address) => address !== options.selfAddress)
                    .map((host) => ({ host, port: options.port, internalPort: options.internalPort })),
            );
            if (closed || sameList(peers, next)) {
                return;
            }
            peers = next;
            for (const listener of listeners) {
                listener(peers);
            }
        },
        close: () => {
            closed = true;
            listeners.clear();
        },
    };
};

// The same thing wired to a real clock, first poll immediately. Unrefed: discovery can never be the reason the
// process stays up.
export const startFlyPeers = (options: FlyPeersOptions & { readonly intervalMs?: number }): FlyPeers => {
    const peers = createFlyPeers(options);
    void peers.refresh();
    const timer = setInterval(() => void peers.refresh(), options.intervalMs ?? FLY_POLL_INTERVAL_MS);
    timer.unref?.();
    return {
        ...peers,
        close: () => {
            clearInterval(timer);
            peers.close();
        },
    };
};
