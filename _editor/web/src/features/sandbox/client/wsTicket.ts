import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

/* The query string a WebSocket upgrade to this daemon should carry.
 *
 * A browser cannot set an Authorization header on a WebSocket, so the terminal and the two screencasts used to
 * put the caller's bearer straight into the URL, a 30-day session token, written somewhere Cloudflare's edge
 * logs it. Now the credential is spent over HTTP, where headers work: POST /system/ws-ticket authenticates
 * normally and returns a ticket good for one upgrade for a few seconds. The URL still carries a secret, but one
 * that is already worthless by the time anything reads a log.
 *
 * A daemon that 404s the mint predates the route. That is the ordinary state of this product, sandboxes are
 * the user's own containers and update on their own schedule, which is why sandboxSession's exchange has the
 * same shape, so the fallback is the old `token`/`connect` pair rather than a broken terminal. It stops being
 * reachable once a sandbox updates, and the daemon it talks to has already stopped accepting it by then. */

/* ONE SNAPSHOT FOR THE WHOLE MINT (sandboxTarget), and every part of it read before the first await.
 *
 * The bearer, the address and the connect token all have to name the SAME sandbox. Asking the session layer
 * for a bearer without handing it a target meant it snapshotted the active sandbox itself, at the top, while
 * the base and the connect token were read underneath the await: a switch in between paired one daemon's
 * session with another daemon's URL, which that daemon can only answer 401 (and then, at the upgrade, 1008). */
const params = async (target: SandboxTarget): Promise<URLSearchParams | undefined> => {
    const connect = target.connectToken;
    if (connect === undefined) {
        return undefined;
    }
    const bearer = await useSandboxSession().getSessionToken(target);
    if (bearer === undefined) {
        return undefined;
    }
    try {
        const response = await fetch(`${target.base}/system/ws-ticket`, {
            method: `POST`,
            headers: { authorization: `Bearer ${bearer.token}`, "x-intentic-connect": connect },
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
    return new URLSearchParams({ token: bearer.token, connect });
};

// The full ws(s):// URL for `path`, with the auth params and `extra` merged in, undefined when the sandbox
// isn't reachable or the user dismissed the sign-in gate (the caller shows its own disconnected state).
export const socketUrl = async (path: string, extra: Record<string, string> = {}): Promise<string | undefined> => {
    // Taken here and carried down, so the URL this returns is built from the same sandbox the ticket was
    // minted against, however long the mint took.
    const target = currentSandboxTarget();
    if (target === undefined) {
        return undefined;
    }
    const auth = await params(target);
    if (auth === undefined) {
        return undefined;
    }
    for (const [key, value] of Object.entries(extra)) {
        auth.set(key, value);
    }
    return `${target.base.replace(/^http/, `ws`)}${path}?${auth.toString()}`;
};
