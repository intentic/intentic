import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { peerKey, type Peer, type PeerDiscovery } from "./peers.js";
import type { RegistryEvent, TunnelRegistry } from "./registry.js";

// Maps which peer holds which tunnel id, so a local miss on this machine is forwarded to the peer that has it.
// A delta `add` displaces a local session for the same id; a full `set` snapshot never displaces, and local routing
// wins instead.
// Only messages from peers discovery still knows are trusted, so the map is bounded by the machine set.

// Marks a request already forwarded once; a hop-marked miss answers 502 instead of forwarding again.
export const HOP_HEADER = `x-intentic-hop`;

export const HOLDS_PATH = `/internal/v1/holds`;

// Expires an entry two sync intervals stale, whether or not discovery has noticed the peer is gone.
export const SYNC_INTERVAL_MS = 30_000;
export const REMOTE_TTL_MS = SYNC_INTERVAL_MS * 2 + 5_000;

// A peer that hasn't answered by now won't; the next full sync repairs whatever was missed.
const SEND_TIMEOUT_MS = 5_000;

// Ceiling on a holds message body, well above what any real cluster's id list would need.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SANDBOX_ID = /^[0-9a-f]{12}$/u;

const PeerSchema = z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    internalPort: z.number().int().positive(),
});

export const HoldsMessageSchema = z.object({
    // Sender, as its peers reach it; validated against discovery before it's trusted.
    from: PeerSchema,
    instance: z.string(),
    op: z.enum([`add`, `remove`, `set`]),
    ids: z.array(z.string().regex(SANDBOX_ID)),
});

export type HoldsMessage = z.infer<typeof HoldsMessageSchema>;

export interface ClusterOptions {
    readonly instanceId: string;
    // This instance as peers reach it; empty host means it cannot advertise, though it still receives and routes.
    readonly self: Peer;
    readonly peers: PeerDiscovery;
    readonly registry: TunnelRegistry;
    readonly log: (event: Record<string, unknown>, message: string) => void;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
}

export interface Cluster {
    // Peer to forward a locally-unknown id to, if any peer has claimed holding it.
    readonly holder: (sandboxId: string) => Peer | undefined;
    // Stop trusting the current holder for this id until told otherwise.
    readonly forget: (sandboxId: string) => void;
    // Handles a holds message that arrived on the internal surface.
    readonly receive: (message: HoldsMessage) => void;
    // Local registry change to broadcast to peers.
    readonly onRegistryChange: (event: RegistryEvent) => void;
    // Expires stale entries and pushes the full held-id list to every peer.
    readonly tick: () => Promise<void>;
    // Ids this machine currently routes to peers (for /health).
    readonly remoteCount: () => number;
    readonly close: () => void;
}

const hostForUrl = (host: string): string => (host.includes(`:`) ? `[${host}]` : host);

export const holdsUrl = (peer: Peer): string => `http://${hostForUrl(peer.host)}:${peer.internalPort}${HOLDS_PATH}`;

export const createCluster = (options: ClusterOptions): Cluster => {
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;
    const ttlMs = options.ttlMs ?? REMOTE_TTL_MS;
    const remote = new Map<string, { readonly peer: Peer; readonly at: number }>();
    let closed = false;

    const known = (peer: Peer): boolean => options.peers.current().some((candidate) => peerKey(candidate) === peerKey(peer));

    const message = (op: HoldsMessage[`op`], ids: readonly string[]): HoldsMessage => ({
        from: options.self,
        instance: options.instanceId,
        op,
        ids: [...ids],
    });

    // Best-effort send to one peer; a failure only logs, since the next full sync repeats the same fact.
    const send = async (peer: Peer, body: HoldsMessage): Promise<void> => {
        if (closed || options.self.host === ``) {
            return;
        }
        try {
            const response = await fetchImpl(holdsUrl(peer), {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            if (!response.ok) {
                options.log({ peer: peerKey(peer), op: body.op, status: response.status }, `holds message refused`);
            }
        } catch (error) {
            options.log({ peer: peerKey(peer), op: body.op, err: String(error) }, `holds message failed`);
        }
    };

    const broadcast = (body: HoldsMessage): void => {
        for (const peer of options.peers.current()) {
            void send(peer, body);
        }
    };

    // Replaces a peer's prior entries with the ids of a `set` snapshot.
    const applySet = (peer: Peer, ids: readonly string[], at: number): void => {
        const key = peerKey(peer);
        for (const [id, entry] of remote) {
            if (peerKey(entry.peer) === key) {
                remote.delete(id);
            }
        }
        for (const id of ids) {
            if (options.registry.lookup(id) !== undefined) {
                // Local routing wins over a peer's snapshot; logged since two live sessions for one id is a
                // misconfiguration.
                options.log({ sandboxId: id, peer: key }, `a peer also holds a tunnel this machine holds`);
            }
            remote.set(id, { peer, at });
        }
    };

    // Asks a newly seen peer what it holds and tells it what this machine holds, without waiting for the next sync.
    const greet = async (peer: Peer): Promise<void> => {
        void send(peer, message(`set`, options.registry.ids()));
        try {
            const response = await fetchImpl(holdsUrl(peer), { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
            if (!response.ok) {
                return;
            }
            const parsed = HoldsMessageSchema.safeParse(await response.json());
            if (parsed.success && !closed) {
                receive(parsed.data);
            }
        } catch (error) {
            options.log({ peer: peerKey(peer), err: String(error) }, `could not read a new peer's holds; the sync will`);
        }
    };

    const receive = (incoming: HoldsMessage): void => {
        if (closed || !known(incoming.from)) {
            options.log({ from: peerKey(incoming.from), instance: incoming.instance, op: incoming.op }, `holds message from a peer discovery does not know; ignored`);
            return;
        }
        const at = now();
        const key = peerKey(incoming.from);
        switch (incoming.op) {
            case `add`: {
                for (const id of incoming.ids) {
                    if (options.registry.displace(id, `displaced by a newer tunnel on ${incoming.instance}`)) {
                        options.log({ sandboxId: id, peer: key }, `local tunnel displaced by a newer one on a peer`);
                    }
                    remote.set(id, { peer: incoming.from, at });
                }
                return;
            }
            case `remove`: {
                // Only the current holder may withdraw an id; a stale `remove` from a displaced peer must not erase the
                // winner.
                for (const id of incoming.ids) {
                    const entry = remote.get(id);
                    if (entry !== undefined && peerKey(entry.peer) === key) {
                        remote.delete(id);
                    }
                }
                return;
            }
            case `set`: {
                applySet(incoming.from, incoming.ids, at);
                return;
            }
        }
    };

    // On discovery change: drop entries whose peer is gone, and greet any peer that's newly arrived.
    let previousKeys = new Set(options.peers.current().map(peerKey));
    const unsubscribe = options.peers.onChange((peers) => {
        const nextKeys = new Set(peers.map(peerKey));
        for (const [id, entry] of remote) {
            if (!nextKeys.has(peerKey(entry.peer))) {
                remote.delete(id);
            }
        }
        for (const peer of peers) {
            if (!previousKeys.has(peerKey(peer))) {
                void greet(peer);
            }
        }
        previousKeys = nextKeys;
    });
    // Peers already known at construction are greeted too, as this machine's first sight of the cluster.
    for (const peer of options.peers.current()) {
        void greet(peer);
    }

    return {
        holder: (sandboxId) => {
            const entry = remote.get(sandboxId);
            if (entry === undefined) {
                return undefined;
            }
            if (now() - entry.at > ttlMs) {
                remote.delete(sandboxId);
                return undefined;
            }
            return entry.peer;
        },
        forget: (sandboxId) => {
            remote.delete(sandboxId);
        },
        receive,
        onRegistryChange: (event) => {
            broadcast(message(event.kind === `register` ? `add` : `remove`, [event.sandboxId]));
        },
        tick: async () => {
            if (closed) {
                return;
            }
            const at = now();
            for (const [id, entry] of remote) {
                if (at - entry.at > ttlMs) {
                    remote.delete(id);
                }
            }
            await Promise.all(options.peers.current().map((peer) => send(peer, message(`set`, options.registry.ids()))));
        },
        remoteCount: () => remote.size,
        close: () => {
            closed = true;
            unsubscribe();
            remote.clear();
        },
    };
};

// Cluster driven by a real interval timer; unrefed so it never keeps the process alive.
export const startCluster = (options: ClusterOptions & { readonly intervalMs?: number }): Cluster => {
    const cluster = createCluster(options);
    const timer = setInterval(() => void cluster.tick(), options.intervalMs ?? SYNC_INTERVAL_MS);
    timer.unref?.();
    return {
        ...cluster,
        close: () => {
            clearInterval(timer);
            cluster.close();
        },
    };
};

// The internal surface.

const readBody = (request: IncomingMessage): Promise<string | undefined> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on(`data`, (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                request.destroy();
                resolve(undefined);
                return;
            }
            chunks.push(chunk);
        });
        request.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)));
        request.on(`error`, () => resolve(undefined));
    });

const json = (response: ServerResponse, status: number, body: object): void => {
    response.writeHead(status, { "content-type": `application/json`, "cache-control": `no-store` });
    response.end(JSON.stringify(body));
};

export interface InternalServerOptions {
    readonly cluster: Cluster;
    readonly registry: TunnelRegistry;
    readonly self: Peer;
    readonly instanceId: string;
}

// GET returns what this machine holds; POST accepts what a peer holds. This port is the cluster's internal surface
// only, never a tunnel door.
export const createInternalServer = (options: InternalServerOptions): Server =>
    createServer((request, response) => {
        void (async () => {
            const path = (request.url ?? `/`).split(`?`)[0];
            if (path === `/health`) {
                json(response, 200, { status: `ok`, instance: options.instanceId });
                return;
            }
            if (path !== HOLDS_PATH) {
                json(response, 404, { error: `not an internal path` });
                return;
            }
            if (request.method === `GET`) {
                const body: HoldsMessage = { from: options.self, instance: options.instanceId, op: `set`, ids: [...options.registry.ids()] };
                json(response, 200, body);
                return;
            }
            if (request.method !== `POST`) {
                json(response, 405, { error: `GET or POST` });
                return;
            }
            const text = await readBody(request);
            if (text === undefined) {
                json(response, 413, { error: `holds message too large` });
                return;
            }
            let parsed: ReturnType<typeof HoldsMessageSchema.safeParse>;
            try {
                parsed = HoldsMessageSchema.safeParse(JSON.parse(text));
            } catch {
                json(response, 400, { error: `not json` });
                return;
            }
            if (!parsed.success) {
                json(response, 400, { error: `not a holds message` });
                return;
            }
            options.cluster.receive(parsed.data);
            json(response, 200, { ok: true });
        })();
    });
