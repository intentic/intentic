import { createBackoff } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import { hostConnectUrl, type HostScopes } from "@intentic/sandbox-contract";
import { RPCHandler } from "@orpc/server/websocket";
import { type HostLink, rememberScopes } from "./config.js";
import { createHostRouter } from "./router.js";

/* The one socket. This computer dials the sandbox and keeps the connection open; everything the agent asks for
 * arrives on it as an oRPC call against `hostContract`, and every answer goes back the same way.
 *
 * OUTBOUND ONLY, and that is the entire networking story: no port is opened here, no router is configured, no
 * VPN is joined. A laptop on hotel wifi behind a corporate proxy can hold this connection because it is an
 * ordinary outbound wss://, the same thing every chat app on the machine is already doing.
 *
 * The socket has exactly two phases. First one plain-JSON `hello` carrying the enrollment token (see
 * host-protocol.ts for why a token must not ride the URL). Then the sandbox attaches its client and the socket
 * is pure oRPC, request/response correlation, argument validation and error shape all belong to the link from
 * that point on, which is why there is no message plumbing left in this file.
 *
 * RECONNECTION IS THE NORMAL CASE, not the failure case. Lids close, wifi changes, tunnels idle out, the sandbox
 * restarts. So the loop treats a dropped socket as routine and comes back on the shared exponential ladder
 * (@intentic/base's createBackoff), and the sandbox's card reads "offline" in the meantime rather than
 * pretending. A link that held for a minute was working and its drop redials at the floor; one that opened and
 * died at once keeps climbing. The one thing that is NOT retried is a refused enrollment (close code 1008): the
 * owner revoked this machine, that never heals on its own, and hammering a door that has been locked is how an
 * agent turns a revocation into a support ticket. */

// Backoff bounds. The first retry is fast because the overwhelmingly common cause is a sandbox restart, which
// takes seconds; the ceiling is low enough that a laptop opened after a night asleep is back within a minute.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 60_000;
// The daemon closes with this when the token is not enrolled, a decision, not a fault.
const UNAUTHORIZED = 1008;

export interface HostConnection {
    // Resolves when the loop is asked to stop (and never rejects, a connection error is a retry, not a throw).
    readonly done: Promise<void>;
    readonly stop: () => void;
}

export const connect = (config: HostLink, version: string, log: Log): HostConnection => {
    /* The live grant. Starts as whatever the last session cached and is replaced by the sandbox's `setScopes`,
     * which arrives immediately after every connect, so a scope the owner turned off is enforced from the first
     * call of the new session, not from the next restart of this agent. */
    let scopes: HostScopes = config.scopes;
    const handler = new RPCHandler(
        createHostRouter({
            scopes: () => scopes,
            setScopes: (next) => {
                scopes = next;
                /* …AND THE CACHE FOR THIS LINK ALONE. The router used to write it, which was fine while a
                 * computer answered to exactly one sandbox and is wrong now that it answers to a list: the
                 * router has no idea which of them pushed. The connection does, because it IS one link, so the
                 * persistence moved to the side that holds the identity. Best-effort and unawaited for the
                 * reason it always was: the live grant above is already enforcing. */
                void rememberScopes(config.sandboxUrl, next);
            },
            log,
        }),
    );

    let stopped = false;
    let socket: WebSocket | undefined;
    let openedAt: number | undefined;
    const ladder = createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS, stableMs: STABLE_MS });
    let resolveDone: () => void;
    const done = new Promise<void>((resolvePromise) => {
        resolveDone = resolvePromise;
    });

    const open = (): void => {
        const ws = new WebSocket(hostConnectUrl(config.sandboxUrl));
        socket = ws;

        ws.addEventListener("open", () => {
            openedAt = Date.now();
            // The handler is attached BEFORE the hello goes out: the sandbox may call the moment it has verified
            // the token, and a race there would drop the first `setScopes`, the one call whose loss would leave
            // this machine enforcing a stale grant.
            handler.upgrade(ws);
            ws.send(JSON.stringify({ type: "hello", token: config.token, version }));
            log(`connected to ${config.sandboxUrl} as "${config.id}"`);
        });

        ws.addEventListener("close", (event) => {
            socket = undefined;
            if (stopped) {
                resolveDone();
                return;
            }
            if (event.code === UNAUTHORIZED) {
                log(
                    "the sandbox refused this computer's enrollment: it was revoked there. Run `intentic-machine computer uninstall` to clean up, or connect again from the sandbox.",
                );
                stopped = true;
                resolveDone();
                return;
            }
            const delay = ladder.next(openedAt === undefined ? 0 : Date.now() - openedAt);
            openedAt = undefined;
            log(`disconnected (${event.code}); reconnecting in ${Math.round(delay / 1000)}s`);
            setTimeout(open, delay);
        });

        // A socket error is always followed by a close event, which owns the retry, this only records the cause,
        // which the close code alone never carries.
        ws.addEventListener("error", () => log("connection error"));
    };

    open();

    return {
        done,
        stop: () => {
            stopped = true;
            socket?.close(1000, "stopping");
            resolveDone();
        },
    };
};
