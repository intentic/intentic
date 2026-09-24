import { converterReadable } from "@intentic/sandbox-contract/peer-mcp-server";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import type { PeerHubSpec } from "./peer.js";
import { memoryPeerTools, type PeerToolMemory } from "./peer-tool-memory.js";

// Live half of a peer door: who holds a socket, and the typed client for each; correlating request/response is the
// link's job. Liveness is in-memory only: online is a socket fact that doesn't survive a restart, and persisting it
// would let the UI claim a reach the daemon doesn't have. What a peer PUBLISHES is the opposite case and does persist
// (peer-tool-memory.ts): a turn must be able to list an asleep browser's tools and be told it is asleep, rather than
// not see it at all.

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
    // False means nobody took it: offline, or a failed push that dropped the peer; it gets the grant on its next connect.
    readonly pushScopes: (id: string, scopes: Scopes) => Promise<boolean>;
    // Cuts a peer off now: the owner revoking it, or the capability being removed.
    readonly disconnect: (id: string, reason: string) => void;
    // Last tool list this peer answered with, cached across disconnects so a turn still lists its tools.
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    // Every peer holding a socket now; checked against the enrollment store by the peers invariant.
    readonly connected: () => readonly string[];
    // Those plus the ones remembered since they dropped: what a machine's environment list is built from, since a
    // distro that went to sleep is still an environment of that machine.
    readonly known: () => readonly string[];
    readonly state: (id: string) => PeerState<Announced, Facts>;
}

// How long a peer has to answer for its tool table at connect; past that, whatever was remembered stands.
const TOOLS_TIMEOUT_MS = 10_000;

export const createPeerHub = <Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes>(
    spec: PeerHubSpec,
    logger: { warn: (data: object, message: string) => void },
    // Where tool tables outlive this process; in-memory when a caller has no durable one (tests, the bench).
    memory: PeerToolMemory = memoryPeerTools(),
): PeerHub<Client, Announced, Facts, Scopes> => {
    const live = new Map<string, LivePeer<Client, Announced, Facts>>();
    const seen = new Map<string, { announced: Announced; facts: Facts | undefined; lastSeen: number }>();
    // One file serves every door, so a peer's tools are keyed by the door they came through as well as its own name.
    const toolKey = (id: string): string => `${spec.domain}:${id}`;

    // Asked for the moment a peer connects rather than whenever a turn first happens to list them: a browser paired
    // between turns, or one whose laptop shut since, must still publish its tools rather than dropping out of the turn.
    const learnTools = async (id: string, client: Client): Promise<void> => {
        if (client.mcp === undefined) {
            return;
        }
        const answer = (await client.mcp(
            { jsonrpc: "2.0", id: `${spec.domain}-tools`, method: "tools/list", params: {} },
            { signal: AbortSignal.timeout(TOOLS_TIMEOUT_MS) },
        )) as { readonly result?: unknown };
        if (answer.result !== undefined) {
            // Converted here as the bridge converts a turn's own listing, so what an asleep peer publishes is byte-for
            // byte what a live one does.
            memory.set(toolKey(id), converterReadable(answer.result));
        }
    };

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
            // Not awaited: a socket must be usable the moment it attaches, and a peer too slow to answer keeps
            // whatever tool table it last published.
            void learnTools(id, connection.client).catch((err: unknown) =>
                logger.warn({ err, id }, `${spec.domain}: could not read this peer's tool list on connect`),
            );
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
            try {
                await peer.client.setScopes(scopes);
                return true;
            } catch (err) {
                // A peer that did not take the grant must not stay attached on the old one; it gets this one on redial.
                logger.warn({ err, id }, `${spec.domain}: could not push this peer's grant, dropping the connection`);
                peer.close(1001, "grant not delivered");
                if (live.get(id) === peer) {
                    drop(id, peer);
                }
                return false;
            }
        },
        rememberTools: (id, result) => memory.set(toolKey(id), result),
        knownTools: (id) => memory.get(toolKey(id)),
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
        // Every peer this hub can say anything about: holding a socket now, or remembered since it dropped. What a
        // machine's environment list is built from, where `connected` alone would lose a distro that went to sleep.
        known: () => [...new Set([...live.keys(), ...seen.keys()])],
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
