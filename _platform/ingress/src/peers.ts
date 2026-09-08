import { promises as dns } from "node:dns";

// A peer is an address and two ports: public (forward.ts routes by Host) and internal (cluster.ts's holds protocol); a
// static list and Fly's internal DNS both produce the same shape.
// Self-exclusion is by address (FLY_PRIVATE_IP), not id, since that's the one fact this instance can match against a
// DNS answer.
// Split into a refresh and a clock, so tests drive `refresh()` against an injected resolver.

export interface Peer {
    readonly host: string;
    readonly port: number;
    readonly internalPort: number;
}

export interface PeerDiscovery {
    readonly current: () => readonly Peer[];
    // Fires with the full new list when it differs from the last; returns the unsubscribe.
    readonly onChange: (listener: (peers: readonly Peer[]) => void) => () => void;
    readonly close: () => void;
}

// How often Fly's DNS is polled; short since it bounds staleness, cheap since it's one local lookup.
export const FLY_POLL_INTERVAL_MS = 10_000;

// Peer identity for map keys: address plus both ports, since one host on two ports is two peers.
export const peerKey = (peer: Peer): string => `${peer.host}|${peer.port}|${peer.internalPort}`;

const sameList = (a: readonly Peer[], b: readonly Peer[]): boolean =>
    a.length === b.length && a.every((peer, index) => peerKey(peer) === peerKey(b[index] ?? peer));

const bySortedKey = (peers: readonly Peer[]): readonly Peer[] => [...peers].sort((a, b) => peerKey(a).localeCompare(peerKey(b)));

// Parses `host[:port[:internalPort]]`; an IPv6 literal is bracketed, `[fdaa::1]:8080:8081`.
// Malformed entries throw rather than get skipped, so a typo surfaces in the boot log instead of silently dropping a
// peer.
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

// A list that is what it was told; `close`/`onChange` exist only to match the PeerDiscovery shape.
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
                // A failed lookup keeps the last answer, so a DNS blip doesn't 502 requests it was already forwarding.
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

// Wired to a real clock, first poll immediate; unrefed so discovery never keeps the process alive.
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
