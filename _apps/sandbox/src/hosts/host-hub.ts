import type { HostFacts, HostScopes, HostServerFrame, HostSummary } from "@intentic/sandbox-contract";

/* The live half of the `host` capability: which of the user's computers are holding a socket right now, and the
 * request/response correlation that turns one WebSocket into a call-and-return channel.
 *
 * The daemon is a PIPE here, not a participant. An MCP message from the agent goes out verbatim and the
 * machine's answer comes back verbatim — so the tool surface is whatever the machine's binary implements, and a
 * machine that grows a new tool needs no daemon release. The only thing rewritten in flight is the JSON-RPC id:
 * two conversations talking to the same machine both start counting at 1, and the second one's `id: 1` would
 * otherwise resolve the first one's pending call with somebody else's answer. Each in-flight call gets a hub-wide
 * id on the way out and its own id back on the way in, so the collision cannot be constructed.
 *
 * Everything here is in memory, deliberately. "Online" is a fact about a socket, and a socket does not survive a
 * restart: after one, every machine reconnects on its own backoff and re-sends its hello. Persisting liveness
 * would only let the UI claim a laptop is up when the daemon has no way to reach it. */

export interface HostConnection {
    readonly send: (frame: HostServerFrame) => void;
    readonly close: (code: number, reason: string) => void;
}

// How long a call may wait for a machine. Far above any tool's own timeout on purpose: the machine bounds its
// own work (a command's timeout is the agent's, not ours), so this only ever catches a machine that stopped
// answering without its socket closing — a half-open connection through a dead tunnel. A closed socket rejects
// its pending calls immediately, which is the fast path this backstops.
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

interface LiveHost {
    readonly connection: HostConnection;
    version: string | undefined;
    facts: HostFacts | undefined;
    lastSeen: number;
    readonly pending: Map<number, { resolve: (payload: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

export interface HostHub {
    // Take over as THE connection for this machine, closing any socket it left behind (a laptop that woke from
    // sleep reconnects long before the old socket's keepalive gives up on it).
    readonly attach: (id: string, connection: HostConnection) => void;
    // Drop this connection if it is still the current one — a stale socket's close must not unregister the
    // machine that already replaced it.
    readonly detach: (id: string, connection: HostConnection) => void;
    readonly hello: (id: string, version: string, facts: HostFacts) => void;
    // An rpc frame arriving FROM a machine: a response to something in flight, or noise we drop.
    readonly deliver: (id: string, payload: unknown) => void;
    // Send a JSON-RPC request and await the machine's answer. Rejects when the machine is offline, its socket
    // closes mid-call, or it goes silent past CALL_TIMEOUT_MS.
    readonly call: (id: string, payload: unknown) => Promise<unknown>;
    // Send a JSON-RPC notification (no id, no answer). False ⇒ the machine is offline.
    readonly notify: (id: string, payload: unknown) => boolean;
    // Push the grant to a connected machine — on attach, and again whenever the owner edits the capability.
    readonly pushScopes: (id: string, scopes: HostScopes) => boolean;
    // Cut a machine off now — the owner revoking it, or removing the capability. Its pending calls reject with
    // the reason rather than waiting out the timeout.
    readonly disconnect: (id: string, reason: string) => void;
    /* The last tool list this machine answered with, remembered across disconnects — the ONE place the hub looks
     * inside a payload, and it earns the exception. A turn loads its MCP servers up front, so a laptop that is
     * asleep at that moment would otherwise fail the handshake and take its tools out of the turn entirely; with
     * the list cached the agent still SEES the machine's tools and gets a readable "this computer is asleep" when
     * it calls one, which is the difference between a model that tells the user to open their laptop and one that
     * reports a broken sandbox. Undefined until the machine has connected once. */
    readonly rememberTools: (id: string, result: unknown) => void;
    readonly knownTools: (id: string) => unknown | undefined;
    readonly online: (id: string) => boolean;
    readonly state: (id: string) => Omit<HostSummary, "id" | "platform">;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A JSON-RPC message's id, or undefined for a notification (which expects no answer).
const idOf = (payload: unknown): string | number | undefined => {
    if (!isRecord(payload)) {
        return undefined;
    }
    const id = payload["id"];
    return typeof id === "string" || typeof id === "number" ? id : undefined;
};

// Fail every call in flight on a machine at once — what a disconnect, a takeover and a revocation all do.
const settle = (host: LiveHost, error: Error): void => {
    for (const [, pending] of host.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
    }
    host.pending.clear();
};

export const createHostHub = (): HostHub => {
    const live = new Map<string, LiveHost>();
    // What each machine reported the last time it was up, kept after it goes offline so the card can say "last
    // seen" and still name the machine's OS instead of going blank the moment a lid closes.
    const seen = new Map<string, { version: string | undefined; facts: HostFacts | undefined; lastSeen: number }>();
    // Last tools/list result per machine — see rememberTools on the interface for why this one payload is read.
    const tools = new Map<string, unknown>();
    // Hub-wide, so an id is unique across machines as well as across conversations.
    let nextCallId = 1;

    return {
        attach: (id, connection) => {
            const previous = live.get(id);
            if (previous !== undefined) {
                settle(previous, new Error("replaced by a newer connection from this machine"));
                previous.connection.close(1000, "replaced");
            }
            const remembered = seen.get(id);
            live.set(id, {
                connection,
                version: remembered?.version,
                facts: remembered?.facts,
                lastSeen: Date.now(),
                pending: new Map(),
            });
        },
        detach: (id, connection) => {
            const host = live.get(id);
            if (host === undefined || host.connection !== connection) {
                return;
            }
            settle(host, new Error(`the machine "${id}" disconnected`));
            seen.set(id, { version: host.version, facts: host.facts, lastSeen: Date.now() });
            live.delete(id);
        },
        hello: (id, version, facts) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            host.version = version;
            host.facts = facts;
            host.lastSeen = Date.now();
        },
        deliver: (id, payload) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            host.lastSeen = Date.now();
            const callId = idOf(payload);
            if (typeof callId !== "number") {
                return;
            }
            const pending = host.pending.get(callId);
            if (pending === undefined) {
                return;
            }
            host.pending.delete(callId);
            clearTimeout(pending.timer);
            pending.resolve(payload);
        },
        call: (id, payload) =>
            new Promise<unknown>((resolve, reject) => {
                const host = live.get(id);
                if (host === undefined) {
                    reject(new Error(`"${id}" is not connected right now — the computer is asleep, offline, or its agent isn't running.`));
                    return;
                }
                const callId = nextCallId++;
                const timer = setTimeout(() => {
                    host.pending.delete(callId);
                    reject(new Error(`"${id}" did not answer within ${Math.round(CALL_TIMEOUT_MS / 60000)} minutes.`));
                }, CALL_TIMEOUT_MS);
                host.pending.set(callId, {
                    // The machine answers with OUR id; the caller gets THEIRS back, so the remap is invisible
                    // on both ends of the pipe.
                    resolve: (answer) => resolve(isRecord(answer) ? { ...answer, id: idOf(payload) ?? null } : answer),
                    reject,
                    timer,
                });
                host.connection.send({ type: "rpc", payload: isRecord(payload) ? { ...payload, id: callId } : payload });
            }),
        notify: (id, payload) => {
            const host = live.get(id);
            if (host === undefined) {
                return false;
            }
            host.connection.send({ type: "rpc", payload });
            return true;
        },
        pushScopes: (id, scopes) => {
            const host = live.get(id);
            if (host === undefined) {
                return false;
            }
            host.connection.send({ type: "scopes", scopes });
            return true;
        },
        rememberTools: (id, result) => void tools.set(id, result),
        knownTools: (id) => tools.get(id),
        disconnect: (id, reason) => {
            const host = live.get(id);
            if (host === undefined) {
                return;
            }
            settle(host, new Error(reason));
            host.connection.close(1000, reason);
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
};
