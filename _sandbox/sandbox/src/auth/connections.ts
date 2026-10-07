import type { Caller } from "./auth.js";
import type { ControlPrincipal } from "./principal.js";

/* Every authenticated long-lived transport whose authorization was decided only when it opened. */
export interface AuthConnections {
    // A member's transport, or a control token's: a program has no member identity, so its token's id keys it.
    readonly register: (holder: Caller | ControlPrincipal, close: () => void) => () => void;
    // No email means the sandbox-wide kill switch, control tokens' transports included. An email closes only that
    // member's live transports.
    readonly revoke: (email?: string) => void;
    // Closes one control token's live transports once it is revoked; until then only its next request was refused.
    readonly revokeControl: (id: string) => void;
    // Hears every revocation, lowercased, for transports held outside this process (netd's terminals). A token's own
    // revocation is not heard: netd's terminals are opened by members only.
    readonly onRevoke: (listener: (email: string | undefined) => void) => () => void;
}

// One key space for both holders, prefixed so an email can never read as a token id.
const keyOf = (holder: Caller | ControlPrincipal): string => ("kind" in holder ? `control:${holder.id}` : `member:${holder.email.toLowerCase()}`);

export const createAuthConnections = (): AuthConnections => {
    let nextId = 0;
    const live = new Map<number, { readonly key: string; readonly close: () => void }>();
    const listeners = new Set<(email: string | undefined) => void>();
    // Undefined closes everything.
    const closeWhere = (key: string | undefined): void => {
        for (const [id, connection] of live) {
            if (key !== undefined && connection.key !== key) {
                continue;
            }
            // Remove first: close() normally re-enters through the transport's cleanup callback.
            live.delete(id);
            connection.close();
        }
    };
    return {
        register: (holder, close) => {
            const id = nextId;
            nextId += 1;
            live.set(id, { key: keyOf(holder), close });
            return () => live.delete(id);
        },
        revoke: (email) => {
            const target = email?.toLowerCase();
            closeWhere(target === undefined ? undefined : `member:${target}`);
            for (const listener of listeners) {
                listener(target);
            }
        },
        revokeControl: (id) => closeWhere(`control:${id}`),
        onRevoke: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
