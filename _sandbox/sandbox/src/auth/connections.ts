import type { Caller } from "./auth.js";

/* Every authenticated browser transport whose authorization was decided only when it opened. */
export interface AuthConnections {
    readonly register: (caller: Caller, close: () => void) => () => void;
    // No email means the sandbox-wide kill switch. An email closes only that member's live transports.
    readonly revoke: (email?: string) => void;
    // Hears every revocation, lowercased, for transports held outside this process (the front's terminals).
    readonly onRevoke: (listener: (email: string | undefined) => void) => () => void;
}

export const createAuthConnections = (): AuthConnections => {
    let nextId = 0;
    const live = new Map<number, { readonly email: string; readonly close: () => void }>();
    const listeners = new Set<(email: string | undefined) => void>();
    return {
        register: (caller, close) => {
            const id = nextId;
            nextId += 1;
            live.set(id, { email: caller.email.toLowerCase(), close });
            return () => live.delete(id);
        },
        revoke: (email) => {
            const target = email?.toLowerCase();
            for (const [id, connection] of live) {
                if (target !== undefined && connection.email !== target) {
                    continue;
                }
                // Remove first: close() normally re-enters through the transport's cleanup callback.
                live.delete(id);
                connection.close();
            }
            for (const listener of listeners) {
                listener(target);
            }
        },
        onRevoke: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
