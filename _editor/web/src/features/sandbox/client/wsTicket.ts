import { useSandboxSession } from "./sandboxSession";
import { currentSandboxTarget, type SandboxTarget } from "./sandboxTarget";

// Mints the query string for a WebSocket upgrade to this daemon. Browsers can't set an Authorization header on
// a WebSocket, so credentials are spent over HTTP first (POST /system/ws-ticket) for a short-lived ticket; a
// daemon that 404s falls back to the old token/connect pair.

// One target snapshot for the whole mint: bearer, base URL and connect token must all name the same sandbox,
// so nothing here is re-read from the active sandbox after an await.
const params = async (target: SandboxTarget): Promise<URLSearchParams | undefined> => {
    // Absent on a member's target (sandboxTarget.ts): the daemon reads it on first-bind only, and a member never binds.
    const connect = target.connectToken;
    const bearer = await useSandboxSession().getSessionToken(target);
    if (bearer === undefined) {
        return undefined;
    }
    try {
        const response = await fetch(`${target.base}/system/ws-ticket`, {
            method: `POST`,
            headers: { authorization: `Bearer ${bearer.token}`, ...(connect === undefined ? {} : { "x-intentic-connect": connect }) },
        });
        if (response.ok) {
            const { ticket } = (await response.json()) as { ticket?: unknown };
            if (typeof ticket === `string`) {
                return new URLSearchParams({ ticket });
            }
        }
    } catch {
        // A failed mint is not a failed connection; fall through and let the upgrade report the problem.
    }
    return new URLSearchParams({ token: bearer.token, ...(connect === undefined ? {} : { connect }) });
};

// Full ws(s):// URL for `path` with auth params and `extra` merged in; undefined when the sandbox isn't
// reachable or the sign-in gate was dismissed.
export const socketUrl = async (path: string, extra: Record<string, string> = {}): Promise<string | undefined> => {
    // Captured here and carried down so the URL is built from the same sandbox the ticket was minted against.
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
