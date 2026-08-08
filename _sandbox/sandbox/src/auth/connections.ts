import type { Caller } from "./auth.js";

/* Every authenticated browser transport whose authorization was decided only when it opened.
 *
 * Ordinary HTTP requests re-run the owner/member check each time. An event stream or WebSocket does not:
 * after its opening request there is no next middleware pass on which a removed member or a rotated session
 * can be rejected. Keeping the close callback beside the verified caller makes revocation an event, rather
 * than waiting for an already-authorized terminal or browser window to happen to disconnect by itself. */
export interface AuthConnections {
    readonly register: (caller: Caller, close: () => void) => () => void;
    // No email means the sandbox-wide kill switch. An email closes only that member's live transports.
    readonly revoke: (email?: string) => void;
}

export const createAuthConnections = (): AuthConnections => {
    let nextId = 0;
    const live = new Map<number, { readonly email: string; readonly close: () => void }>();
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
        },
    };
};
