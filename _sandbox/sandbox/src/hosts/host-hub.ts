import type { ContractRouterClient } from "@orpc/contract";
import type { HostFacts, hostContract, HostScopes, HostSummary } from "@intentic/sandbox-contract";

/* The live half of the `host` capability: which of the user's computers are holding a socket right now, and the
 * typed client for each.
 *
 * There is no request/response plumbing in here, and that is the point of the shape. The socket speaks
 * `hostContract` over oRPC's websocket adapter, so correlating an answer to its question, which used to be a
 * hand-rolled id remap in this file, because two conversations both start their JSON-RPC ids at 1, is the
 * link's job now. What is left is what only this daemon can know: who is connected, what they last told us, and
 * what to do when they go away.
 *
 * Everything here is in memory, deliberately. "Online" is a fact about a socket, and a socket does not survive a
 * restart: after one, every machine reconnects on its own backoff and re-announces itself. Persisting liveness
 * would only let the UI claim a laptop is up when the daemon has no way to reach it. */

// The typed client for one machine, every call in hostContract, over its own socket.
export type HostClient = ContractRouterClient<typeof hostContract>;

// A machine that goes silent without closing its socket (a tunnel that died mid-flight) would otherwise hold a
// tool call open forever. Far above any tool's own timeout: the machine bounds its own work, so this only ever
// catches a connection that is gone but not closed, which the heartbeat below is the primary defence against.
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

// Keepalive and liveness in one: frequent enough to stay inside the idle timeout of every tunnel and proxy in
// the path, and the failure that tells us a lid closed without a close frame ever arriving.
const HEARTBEAT_MS = 30_000;

interface LiveHost {
    readonly client: HostClient;
    readonly close: (code: number, reason: string) => void;
    readonly heartbeat: NodeJS.Timeout;
    version: string | undefined;
    facts: HostFacts | undefined;
    lastSeen: number;
}

export interface HostHub {
    /* Take over as THE connection for this machine, closing any socket it left behind (a laptop waking from
     * sleep reconnects long before the old socket's keepalive gives up on it). Returns a detach function for the
     * socket's own close handler, calling it after a newer connection replaced this one does nothing, which is
     * what stops a stale socket from unregistering its own replacement. */
    readonly attach: (id: string, connection: { client: HostClient; close: (code: number, reason: string) => void }) => () => void;
    // What the machine said about itself on connect, and what it answered to `describe`.
    readonly announce: (id: string, version: string) => void;
    readonly observe: (id: string, facts: HostFacts) => void;
    // The typed client for a connected machine, or undefined when it is offline. Callers that need a REASON for
    // the absence use `mcp`, which throws one the model can read.
    readonly client: (id: string) => HostClient | undefined;
    /* One MCP message to a machine. Throws when the machine is offline, with the sentence the agent ends up
     * reading, since an asleep laptop is a normal state, not a fault.
     *
     * `signal` is how a caller states its OWN deadline, and a caller serving a browser needs one: CALL_TIMEOUT_MS
     * is sized for a tool call an agent made on purpose and will wait minutes for, which is the wrong ceiling
     * entirely for a read behind a page (see machine-reports.ts PULL_TIMEOUT_MS). Absent ⇒ the fifteen-minute
     * backstop, which is right for everything that is genuinely a tool call. */
    readonly mcp: (id: string, payload: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
    // Push the grant. False ⇒ nobody to push to; the machine gets it on its next connect instead.
    readonly pushScopes: (id: string, scopes: HostScopes) => Promise<boolean>;
    // Cut a machine off now, the owner revoking it, or removing the capability.
    readonly disconnect: (id: string, reason: string) => void;
    /* The last tool list this machine answered with, remembered across disconnects. A turn loads its MCP servers
     * up front, so a laptop that is asleep at that moment would otherwise fail the handshake and take its tools
     * out of the turn entirely; with the list cached the agent still SEES them and gets a readable "this computer
     * is asleep" when it calls one, the difference between a model that tells the user to open their laptop and
     * one that reports a broken sandbox. Undefined until the machine has connected once. */
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    readonly state: (id: string) => Omit<HostSummary, "id" | "platform">;
}

export const createHostHub = (logger: { warn: (data: object, message: string) => void }): HostHub => {
    const live = new Map<string, LiveHost>();
    // What each machine reported the last time it was up, kept after it goes offline so the card can say "last
    // seen" and still name the machine's OS instead of going blank the moment a lid closes.
    const seen = new Map<string, { version: string | undefined; facts: HostFacts | undefined; lastSeen: number }>();
    const tools = new Map<string, unknown>();

    const drop = (id: string, host: LiveHost): void => {
        clearInterval(host.heartbeat);
        seen.set(id, { version: host.version, facts: host.facts, lastSeen: Date.now() });
        live.delete(id);
    };

    const hub: HostHub = {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                clearInterval(previous.heartbeat);
                previous.close(1000, "replaced");
                live.delete(id);
            }
            const remembered = seen.get(id);
            const host: LiveHost = {
                client: connection.client,
                close: connection.close,
                // A machine that stops answering is dropped rather than left looking online, the card's dot is
                // read as "the agent can work here right now", so it has to be a probe, not a memory.
                heartbeat: setInterval(() => {
                    void connection.client.ping().catch((err: unknown) => {
                        logger.warn({ err, id }, "host: heartbeat failed, dropping the connection");
                        connection.close(1001, "no answer");
                        const current = live.get(id);
                        if (current?.client === connection.client) {
                            drop(id, current);
                        }
                    });
                }, HEARTBEAT_MS),
                version: remembered?.version,
                facts: remembered?.facts,
                lastSeen: Date.now(),
            };
            live.set(id, host);
            return () => {
                const current = live.get(id);
                if (current === host) {
                    drop(id, host);
                }
            };
        },
        announce: (id, version) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            host.version = version;
            host.lastSeen = Date.now();
        },
        observe: (id, facts) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            host.facts = facts;
            host.lastSeen = Date.now();
        },
        client: (id) => live.get(id)?.client,
        mcp: async (id, payload, options) => {
            const host = live.get(id);
            if (host === undefined) {
                throw new Error(`"${id}" is not connected right now: the computer is asleep, offline, or its agent isn't running.`);
            }
            host.lastSeen = Date.now();
            return await host.client.mcp(payload, { signal: options?.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS) });
        },
        pushScopes: async (id, scopes) => {
            const host = live.get(id);
            if (host === undefined) {
                return false;
            }
            await host.client.setScopes(scopes);
            return true;
        },
        rememberTools: (id, result) => void tools.set(id, result),
        knownTools: (id) => tools.get(id),
        disconnect: (id, reason) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            clearInterval(host.heartbeat);
            host.close(1000, reason);
            seen.delete(id);
            live.delete(id);
        },
        online: (id) => live.has(id),
        state: (id) => {
            const host = live.get(id);
            const remembered = host ?? seen.get(id);
            return {
                online: host !== undefined,
                ...(remembered?.version !== undefined ? { version: remembered.version } : {}),
                ...(remembered?.facts !== undefined ? { facts: remembered.facts } : {}),
                ...(remembered !== undefined ? { lastSeen: remembered.lastSeen } : {}),
            };
        },
    };
    return hub;
};
