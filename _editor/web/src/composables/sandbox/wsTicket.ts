import { useEndpoint } from "./useEndpoint";
import { useSandbox } from "./useSandbox";
import { useSandboxSession } from "./sandboxSession";

/* The query string a WebSocket upgrade to this daemon should carry.
 *
 * A browser cannot set an Authorization header on a WebSocket, so the terminal and the two screencasts used to
 * put the caller's bearer straight into the URL — a 30-day session token, written somewhere Cloudflare's edge
 * logs it. Now the credential is spent over HTTP, where headers work: POST /system/ws-ticket authenticates
 * normally and returns a ticket good for one upgrade for a few seconds. The URL still carries a secret, but one
 * that is already worthless by the time anything reads a log.
 *
 * A daemon that 404s the mint predates the route. That is the ordinary state of this product — sandboxes are
 * the user's own containers and update on their own schedule, which is why sandboxSession's exchange has the
 * same shape — so the fallback is the old `token`/`connect` pair rather than a broken terminal. It stops being
 * reachable once a sandbox updates, and the daemon it talks to has already stopped accepting it by then. */

const params = async (): Promise<URLSearchParams | undefined> => {
    const token = await useSandboxSession().getSessionToken();
    if (token === undefined) {
        return undefined;
    }
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    // Read the connect token AFTER the await, so it and the base come from one active-sandbox snapshot: a
    // sandbox switch mid-await would otherwise pair a base with another sandbox's token.
    const connect = useSandbox().active.value?.token;
    if (connect === undefined) {
        return undefined;
    }
    try {
        const response = await fetch(`${base}/system/ws-ticket`, {
            method: `POST`,
            headers: { authorization: `Bearer ${token}`, "x-intentic-connect": connect },
        });
        if (response.ok) {
            const { ticket } = (await response.json()) as { ticket?: unknown };
            if (typeof ticket === `string`) {
                return new URLSearchParams({ ticket });
            }
        }
    } catch {
        // A failed mint is not a failed connection: fall through and let the upgrade itself report the problem.
    }
    return new URLSearchParams({ token, connect });
};

// The full ws(s):// URL for `path`, with the auth params and `extra` merged in — undefined when the sandbox
// isn't reachable or the user dismissed the sign-in gate (the caller shows its own disconnected state).
export const socketUrl = async (path: string, extra: Record<string, string> = {}): Promise<string | undefined> => {
    const auth = await params();
    if (auth === undefined) {
        return undefined;
    }
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    for (const [key, value] of Object.entries(extra)) {
        auth.set(key, value);
    }
    return `${base.replace(/^http/, `ws`)}${path}?${auth.toString()}`;
};
