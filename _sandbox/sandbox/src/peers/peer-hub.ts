import { publishRuntimeChange } from "../system/runtime-watch.js";
import type { PeerHubSpec } from "./peer.js";

// Live half of a peer door: who holds a socket, and the typed client for each; correlating request/response is the
// link's job. In-memory only: online is a socket fact that doesn't survive a restart, and persisting it would let the
// UI claim a reach the daemon doesn't have.

// What every peer's contract answers; method-typed so an oRPC client satisfies it structurally. Optional where only
// some doors have the procedure (a runner has no MCP pipe or grant).
export interface PeerClient<Facts, Scopes> {
    describe(input?: undefined, options?: { readonly signal?: AbortSignal }): Promise<Facts>;
    ping(input?: undefined, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
    mcp?(payload: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
    setScopes?(scopes: Scopes, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

// One peer as a card reads it: liveness plus what it last said, kept after it disconnects so the card names it instead
// of going blank. `announced` is its hello; `facts` its last `describe`.
export interface PeerState<Announced, Facts> {
    readonly online: boolean;
    readonly lastSeen?: number;
    readonly announced?: Announced;
    readonly facts?: Facts;
}

interface LivePeer<Client, Announced, Facts> {
    readonly client: Client;
    readonly close: (code: number, reason: string) => void;
    readonly heartbeat: NodeJS.Timeout;
    announced: Announced;
    facts: Facts | undefined;
    lastSeen: number;
}

export interface PeerHub<Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes> {
    // Takes over as this peer's connection, closing any old socket; the returned detach no-ops once replaced.
    readonly attach: (id: string, connection: { client: Client; close: (code: number, reason: string) => void; announced: Announced }) => () => void;
    // Replaces what the peer announced mid-session (e.g. a runner whose settings were just pushed).
    readonly announce: (id: string, announced: Announced) => void;
    // What the peer answered to `describe`.
    readonly observe: (id: string, facts: Facts) => void;
    // Re-asks a live peer to `describe` within a budget; keeps the last answer if away or slow, not nothing.
    readonly refresh: (id: string, timeoutMs: number) => Promise<void>;
    // Typed client for a connected peer, undefined when offline; use `mcp` instead for a reason the model can read.
    readonly client: (id: string) => Client | undefined;
    // Throws when offline; pass `signal` for a deadline shorter than the default tool-call ceiling.
    readonly mcp: (id: string, payload: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
    // False means nobody to push to; the peer gets the grant on its next connect instead.
    readonly pushScopes: (id: string, scopes: Scopes) => Promise<boolean>;
    // Cuts a peer off now: the owner revoking it, or the capability being removed.
    readonly disconnect: (id: string, reason: string) => void;
    // Last tool list this peer answered with, cached across disconnects so a turn still lists its tools.
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    // Every peer holding a socket now; checked against the enrollment store by the peers invariant.
    readonly connected: () => readonly string[];
    readonly state: (id: string) => PeerState<Announced, Facts>;
}

export const createPeerHub = <Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes>(
    spec: PeerHubSpec,
    logger: { warn: (data: object, message: string) => void },
): PeerHub<Client, Announced, Facts, Scopes> => {
    const live = new Map<string, LivePeer<Client, Announced, Facts>>();
    const seen = new Map<string, { announced: Announced; facts: Facts | undefined; lastSeen: number }>();
    const tools = new Map<string, unknown>();

    // Only signal for this hub's state; never call from `refresh`, or a reader path would refetch itself forever.
    const said = (): void => publishRuntimeChange(spec.domain);

    const drop = (id: string, peer: LivePeer<Client, Announced, Facts>): void => {
        clearInterval(peer.heartbeat);
        seen.set(id, { announced: peer.announced, facts: peer.facts, lastSeen: Date.now() });
        live.delete(id);
        said();
    };

    return {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                clearInterval(previous.heartbeat);
                previous.close(1000, "replaced");
                live.delete(id);
            }
            const peer: LivePeer<Client, Announced, Facts> = {
                client: connection.client,
                close: connection.close,
                // Dropped on heartbeat failure, not left looking online; the dot must mean reachable now, not
                // remembered.
                heartbeat: setInterval(() => {
                    void connection.client.ping().catch((err: unknown) => {
                        logger.warn({ err, id }, `${spec.domain}: heartbeat failed, dropping the connection`);
                        connection.close(1001, "no answer");
                        const current = live.get(id);
                        if (current?.client === connection.client) {
                            drop(id, current);
                        }
                    });
                }, spec.heartbeatMs),
                announced: connection.announced,
                facts: seen.get(id)?.facts,
                lastSeen: Date.now(),
            };
            live.set(id, peer);
            said();
            return () => {
                const current = live.get(id);
                if (current === peer) {
                    drop(id, peer);
                }
            };
        },
        announce: (id, announced) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            peer.announced = announced;
            peer.lastSeen = Date.now();
            said();
        },
        observe: (id, facts) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            peer.facts = facts;
            peer.lastSeen = Date.now();
            // Fires once per hello; unlike `refresh`, safe to publish from without looping.
            said();
        },
        refresh: async (id, timeoutMs) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            // A failed describe isn't a card failure; the peer may have just gone, and the last answer beats nothing.
            const fresh = await peer.client.describe(undefined, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
            if (fresh !== undefined) {
                peer.facts = fresh;
                peer.lastSeen = Date.now();
            }
        },
        client: (id) => live.get(id)?.client,
        mcp: async (id, payload, options) => {
            const peer = live.get(id);
            if (peer === undefined || peer.client.mcp === undefined) {
                throw new Error(spec.offline(id));
            }
            peer.lastSeen = Date.now();
            return await peer.client.mcp(payload, { signal: options?.signal ?? AbortSignal.timeout(spec.callTimeoutMs) });
        },
        pushScopes: async (id, scopes) => {
            const peer = live.get(id);
            if (peer === undefined || peer.client.setScopes === undefined) {
                return false;
            }
            await peer.client.setScopes(scopes);
            return true;
        },
        rememberTools: (id, result) => void tools.set(id, result),
        knownTools: (id) => tools.get(id),
        disconnect: (id, reason) => {
            const peer = live.get(id);
            if (peer === undefined) {
                return;
            }
            clearInterval(peer.heartbeat);
            peer.close(1000, reason);
            seen.delete(id);
            live.delete(id);
            said();
        },
        online: (id) => live.has(id),
        connected: () => [...live.keys()],
        state: (id) => {
            const peer = live.get(id);
            const remembered = peer ?? seen.get(id);
            return {
                online: peer !== undefined,
                ...(remembered === undefined ? {} : { lastSeen: remembered.lastSeen, announced: remembered.announced }),
                ...(remembered?.facts !== undefined ? { facts: remembered.facts } : {}),
            };
        },
    };
};
