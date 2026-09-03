import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { peerKey, type Peer, type PeerDiscovery } from "./peers.js";
import type { RegistryEvent, TunnelRegistry } from "./registry.js";

/* WHICH MACHINE HOLDS WHICH TUNNEL, across several of this process, and it is soft state on purpose.
 *
 * THE PROBLEM IT ANSWERS. The registry (registry.ts) is a Map in one process. Put N of these processes behind
 * one anycast address and a sandbox's tunnel lands on the machine nearest the SANDBOX while a browser lands on
 * the machine nearest the BROWSER — and when those differ, the browser's machine looks up an id it has never
 * seen and answers 502 for a sandbox that is connected and serving on the machine next door. Every request
 * from a phone away from home, every invited member, every hosted sandbox reached from a desk: all of them are
 * the mismatch case. One machine was the only count at which the edge was correct.
 *
 * THE SHAPE OF THE ANSWER. Each machine keeps its own registry exactly as before, plus a second map here:
 * which PEER holds the ids it does not. A local miss is then a forward (forward.ts) to that peer over the
 * private network, and the peer routes the request by Host as if it had arrived from the internet. What makes
 * this map cheap enough to hold loosely is that a wrong entry costs one failed forward — the peer answers 502
 * or refuses the connection — after which the entry is forgotten and the browser gets the same 502 it would
 * have gotten with no map at all. Nothing is ever worse than before; it is only sometimes better.
 *
 * HOW THE MAP IS FILLED, and both halves are needed:
 *   • DELTAS. A tunnel registering or leaving is told to every peer at once (`add` / `remove`), so the common
 *     case — a container dialled ten seconds ago and its owner's phone asks a different machine — is already
 *     known by the time it is asked.
 *   • FULL SYNC. Every machine pushes its whole held-id list (`set`) to every peer each interval. This is
 *     anti-entropy: a delta lost to a restart or a dropped connection is repaired within one interval, a
 *     machine that just joined learns the world within one, and an entry that stops being refreshed expires.
 *     Ids are twelve bytes, so ten thousand of them are ~150 KB per peer per interval.
 *   • PULL ON SIGHT. When discovery reports a machine this one had not seen, its holds are fetched at once
 *     and this machine's own are pushed to it, so `fly scale count +1` does not wait out an interval before
 *     the new machine is useful.
 *
 * NEWEST WINS, ACROSS THE CLUSTER. A delta `add` for an id this machine holds LOCALLY displaces the local
 * session (registry.displace, close code 4001): the container redialled and landed elsewhere, and the promise
 * that "a second tunnel for an id takes it" has to hold whichever machine the second one hit. A full-sync
 * `set` never displaces: it is a snapshot, not an event, and two live sessions in it (a token run twice) are
 * a misconfiguration to log, not a fight to start — local routing wins there, as it always did.
 *
 * WHO MAY SPEAK. The internal surface is on its own port (config.ts), bound to the private network, and a
 * message is honoured only when the peer it claims to come from is one discovery knows. That bounds the map
 * to the machine set: a vanished machine's entries are dropped the moment discovery drops the machine, which
 * is also why the map needs no reaper.
 *
 * Split into a state machine (`tick`) and a clock (`start`) the way heartbeat.ts is, so the tests drive it. */

// Marks a request one machine handed to another. A hop-marked request that misses the local registry answers
// 502 and is never forwarded again, which is the whole of the loop guard: at most one hop, ever.
export const HOP_HEADER = `x-intentic-hop`;

export const HOLDS_PATH = `/internal/v1/holds`;

// The full-sync interval, and the expiry that hangs off it: an entry two syncs stale belongs to a peer that
// has stopped talking, whether or not discovery has noticed yet.
export const SYNC_INTERVAL_MS = 30_000;
export const REMOTE_TTL_MS = SYNC_INTERVAL_MS * 2 + 5_000;

// A peer that has not answered a holds message in this long is not going to; the sync repairs whatever was
// missed, so nothing here retries.
const SEND_TIMEOUT_MS = 5_000;

// Ten thousand ids are ~150 KB; this is the ceiling on what a message may carry, well above any real cluster.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SANDBOX_ID = /^[0-9a-f]{12}$/u;

const PeerSchema = z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    internalPort: z.number().int().positive(),
});

export const HoldsMessageSchema = z.object({
    // The sender, as its peers reach it. Validated against discovery before anything is believed.
    from: PeerSchema,
    instance: z.string(),
    op: z.enum([`add`, `remove`, `set`]),
    ids: z.array(z.string().regex(SANDBOX_ID)),
});

export type HoldsMessage = z.infer<typeof HoldsMessageSchema>;

export interface ClusterOptions {
    readonly instanceId: string;
    // This instance as its peers reach it. Empty host ⇒ this machine cannot advertise (it still receives,
    // routes and forwards), which main.ts warns about when there are peers to advertise to.
    readonly self: Peer;
    readonly peers: PeerDiscovery;
    readonly registry: TunnelRegistry;
    readonly log: (event: Record<string, unknown>, message: string) => void;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
}

export interface Cluster {
    // The peer to forward a locally-unknown id to, if any peer has said it holds it.
    readonly holder: (sandboxId: string) => Peer | undefined;
    // A forward to the holder failed: stop believing it until a peer says otherwise.
    readonly forget: (sandboxId: string) => void;
    // A holds message arrived on the internal surface.
    readonly receive: (message: HoldsMessage) => void;
    // What the registry did locally; the cluster tells the peers.
    readonly onRegistryChange: (event: RegistryEvent) => void;
    // One interval elapsed: expire stale entries and push the full held-id list to every peer.
    readonly tick: () => Promise<void>;
    // For /health: how many ids this machine routes to peers.
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

    /* One message to one peer, best effort. A failure is a debug line and nothing else: the next full sync
     * carries the same fact, and retrying here would only pile onto a peer that is already struggling. */
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

    // What a peer just told us it holds, as a snapshot: its previous entries go, these come.
    const applySet = (peer: Peer, ids: readonly string[], at: number): void => {
        const key = peerKey(peer);
        for (const [id, entry] of remote) {
            if (peerKey(entry.peer) === key) {
                remote.delete(id);
            }
        }
        for (const id of ids) {
            if (options.registry.lookup(id) !== undefined) {
                // Local routing wins; this is a snapshot, not a claim. Logged because a token run twice is a
                // misconfiguration somebody should see, and this is the only place it is visible.
                options.log({ sandboxId: id, peer: key }, `a peer also holds a tunnel this machine holds`);
            }
            remote.set(id, { peer, at });
        }
    };

    /* A machine discovery had not shown before: ask it what it holds and tell it what we hold, so neither of
     * us waits out a sync interval to be useful to the other. */
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
                // Only the holder may withdraw an id: a stale `remove` from a peer that lost it to another
                // must not erase the winner's entry.
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

    // Discovery moved: a vanished peer's entries go now, a new peer is greeted now.
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
    // Peers known at construction are greeted too: this is the joiner's own first sight of the cluster.
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

// The cluster wired to a real clock. Unrefed, like every timer in this process.
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

// ── The internal surface ────────────────────────────────────────────────────────────────────────────────

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

/* Two verbs on one path: GET answers what this machine holds (a peer greeting us reads it), POST is a peer
 * telling us what it holds. Nothing else, and no tunnel door: this port is the cluster's, never a sandbox's. */
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
