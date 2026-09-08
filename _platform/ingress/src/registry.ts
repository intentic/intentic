import type { IngressSession } from "@intentic/sandbox-contract/ingress-protocol";

// In-memory map of which tunnel serves which sandbox on this machine, nothing else; not durable, since a tunnel's truth
// cannot outlive the process holding it.
// Displacement is the whole design: a second tunnel claiming an id takes it and closes the previous session with
// `DISPLACED_CODE`; the newest connection always wins.
// The old session's teardown cannot evict its replacement (see `unregister`).

// Close code for a session displaced by a newer one; app range (4000-4999), distinct from an ordinary close.
export const DISPLACED_CODE = 4001;

export interface TunnelEntry {
    readonly session: IngressSession;
    // Ends the peer's WebSocket; held here since displacement is the registry's decision to act on.
    readonly close: (code: number, reason: string) => void;
}

// What the registry tells the cluster: a local tunnel came or went.
export interface RegistryEvent {
    readonly kind: `register` | `unregister`;
    readonly sandboxId: string;
}

export interface TunnelRegistryOptions {
    readonly onChange?: (event: RegistryEvent) => void;
}

export interface TunnelRegistry {
    // Takes the id for this session, closing whatever held it; returns whether something was displaced.
    readonly register: (sandboxId: string, entry: TunnelEntry) => boolean;
    // Closes and drops the local session for an id a peer's registration claimed; returns whether one was held.
    readonly displace: (sandboxId: string, reason: string) => boolean;
    // Gives the id up only if this session still holds it.
    // A displaced session's close fires after its replacement registers; an unconditional delete would orphan the new
    // tunnel's route.
    readonly unregister: (sandboxId: string, session: IngressSession) => void;
    readonly lookup: (sandboxId: string) => IngressSession | undefined;
    readonly size: () => number;
    // Every registered id, for the edge's status surface.
    readonly ids: () => readonly string[];
}

export const createTunnelRegistry = (options: TunnelRegistryOptions = {}): TunnelRegistry => {
    const tunnels = new Map<string, TunnelEntry>();

    return {
        register: (sandboxId, entry) => {
            const previous = tunnels.get(sandboxId);
            tunnels.set(sandboxId, entry);
            options.onChange?.({ kind: `register`, sandboxId });
            if (previous === undefined) {
                return false;
            }
            // The replacement is in the map before the loser is told, so there's no window where the id routes nowhere.
            previous.close(DISPLACED_CODE, `displaced by a newer tunnel`);
            previous.session.close();
            return true;
        },
        displace: (sandboxId, reason) => {
            const held = tunnels.get(sandboxId);
            if (held === undefined) {
                return false;
            }
            // Dropped before the socket closes, with no event raised: the id moved, it didn't leave the cluster.
            tunnels.delete(sandboxId);
            held.close(DISPLACED_CODE, reason);
            held.session.close();
            return true;
        },
        unregister: (sandboxId, session) => {
            if (tunnels.get(sandboxId)?.session === session) {
                tunnels.delete(sandboxId);
                options.onChange?.({ kind: `unregister`, sandboxId });
            }
        },
        lookup: (sandboxId) => tunnels.get(sandboxId)?.session,
        size: () => tunnels.size,
        ids: () => [...tunnels.keys()],
    };
};
