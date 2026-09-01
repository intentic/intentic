import type { IngressSession } from "@intentic/sandbox-contract/ingress-protocol";

/* WHICH TUNNEL SERVES WHICH SANDBOX, and nothing else. This is the entire state the edge keeps, it lives in
 * memory, and it is deliberately not durable: a tunnel is a live connection, so the truth about it cannot
 * outlive the process holding it. An edge that restarts forgets every registration and every container redials
 * within its backoff — which is also why the edge scales by adding machines rather than by sharing a store.
 *
 * DISPLACEMENT IS THE WHOLE DESIGN. A second tunnel claiming an id takes it, and the previous session is
 * closed with 4001. Under the hub this replaced, a recreated container fought its dead predecessor for a name
 * the hub still believed was held, and the loser was whichever box asked second — so `docker rm -f` followed
 * by a fresh run produced a sandbox that 502'd on its own address until a reaper noticed. Here the new
 * container is by definition the live one, so the fight cannot exist: the newest grant-bearing connection
 * wins, always, and the old session's teardown cannot evict it (see `unregister`).
 */

// The WebSocket close code for a session that lost its id to a newer one. In the application range (4000-4999)
// so it can never collide with a protocol code, and distinct from an ordinary close so the daemon's reconnect
// loop can tell "you were replaced" from "the edge went away".
export const DISPLACED_CODE = 4001;

export interface TunnelEntry {
    readonly session: IngressSession;
    // Ends the peer's WebSocket. Held by the registry because displacement is the registry's decision, and the
    // only way to act on it is to close the connection the losing session rides.
    readonly close: (code: number, reason: string) => void;
}

export interface TunnelRegistry {
    /* Take the id for this session, closing whatever held it. Returns whether anything was displaced, which is
     * only ever a log line — the caller has no decision to make either way. */
    readonly register: (sandboxId: string, entry: TunnelEntry) => boolean;
    /* Give the id up, but ONLY if this session still holds it.
     *
     * The guard is not defensive tidiness, it is the correctness of displacement. A displaced session's close
     * handler fires AFTER its replacement has registered, so an unconditional delete here would hand the new
     * container an id that routes nowhere and leave it that way until it happened to redial. Every route to
     * that sandbox would 502 in the meantime, with a perfectly healthy tunnel attached. */
    readonly unregister: (sandboxId: string, session: IngressSession) => void;
    readonly lookup: (sandboxId: string) => IngressSession | undefined;
    readonly size: () => number;
    // Every registered id, for the edge's own status surface.
    readonly ids: () => readonly string[];
}

export const createTunnelRegistry = (): TunnelRegistry => {
    const tunnels = new Map<string, TunnelEntry>();

    return {
        register: (sandboxId, entry) => {
            const previous = tunnels.get(sandboxId);
            tunnels.set(sandboxId, entry);
            if (previous === undefined) {
                return false;
            }
            /* The replacement is already in the map before the loser is told, so there is no window in which
             * the id routes nowhere: closing a WebSocket runs handlers that reach back into this registry. */
            previous.close(DISPLACED_CODE, `displaced by a newer tunnel`);
            previous.session.close();
            return true;
        },
        unregister: (sandboxId, session) => {
            if (tunnels.get(sandboxId)?.session === session) {
                tunnels.delete(sandboxId);
            }
        },
        lookup: (sandboxId) => tunnels.get(sandboxId)?.session,
        size: () => tunnels.size,
        ids: () => [...tunnels.keys()],
    };
};
