import { createBackoff } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import { hostConnectUrl, type HostScopes } from "@intentic/sandbox-contract";
import { RPCHandler } from "@orpc/server/websocket";
import { type DaemonBase, resolveDaemonBase } from "../daemon-base.js";
import { type HostLink, rememberScopes } from "./config.js";
import { createHostRouter } from "./router.js";

/* The one socket. This computer dials the sandbox and keeps the connection open; everything the agent asks for
 * arrives on it as an oRPC call against `hostContract`, and every answer goes back the same way.
 *
 * OUTBOUND ONLY, and that is the entire networking story: no port is opened here, no router is configured, no
 * VPN is joined. A laptop on hotel wifi behind a corporate proxy can hold this connection because it is an
 * ordinary outbound wss://, the same thing every chat app on the machine is already doing.
 *
 * WHERE IT DIALS is resolved per attempt rather than fixed to the link's public URL (../daemon-base.ts, the
 * same resolver the sync half's watcher uses): the sandbox's own container on this machine's loopback when
 * /health there names the sandbox this link is for, the public URL as the floor. It matters here for a
 * different reason than it does for a Mutagen stream. A socket carries kilobytes, so the edge costs it
 * nothing worth saving; what it costs is REACHABILITY. A sandbox running on this very machine whose tunnel is
 * down — a dev box, an ingress mid-move, an edge answering 502 for an hour — used to read "offline" on its own
 * Computers tab while the sync half of this same process was polling the container a loopback hop away, and
 * every control on that tab hangs on this socket being up.
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

/* The two things between this loop and the network, injectable together because a test of WHICH address gets
 * dialled needs to stand in for both: the answer to "where is the daemon" and the socket that answer is
 * handed to. Production wires the real resolver and the runtime's own WebSocket. */
export interface Dial {
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly socket: (url: string) => WebSocket;
}

const realDial: Dial = { resolveBase: resolveDaemonBase, socket: (url) => new WebSocket(url) };

export const connect = (config: HostLink, version: string, log: Log, dial: Dial = realDial): HostConnection => {
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

    const open = async (): Promise<void> => {
        /* Asked on EVERY attempt, never once at startup, because the answer is exactly what a reconnect is
         * about: the container this socket was on went away (an update recreated it, the user stopped it, the
         * sandbox moved to another machine), or one appeared where there was none (docker came up after login).
         * The ordinary case costs nothing — a loopback port with no listener refuses in under a millisecond —
         * and the one that costs a probe's budget is a hung socket, which is the case worth spending it on. */
        const { base, local } = await dial.resolveBase(config.sandboxUrl);
        // Stopped while the address was still being decided: there is nothing to open, and `stop` has already
        // settled `done`.
        if (stopped) {
            return;
        }
        const ws = dial.socket(hostConnectUrl(base));
        socket = ws;

        ws.addEventListener("open", () => {
            openedAt = Date.now();
            // The handler is attached BEFORE the hello goes out: the sandbox may call the moment it has verified
            // the token, and a race there would drop the first `setScopes`, the one call whose loss would leave
            // this machine enforcing a stale grant.
            handler.upgrade(ws);
            ws.send(JSON.stringify({ type: "hello", token: config.token, version }));
            // The loopback case is said, because it is the one a reader of this log cannot infer from the
            // link's own address, and the one that explains a machine that is "connected" with its tunnel down.
            log(`connected to ${config.sandboxUrl}${local ? ` over loopback (${base})` : ""} as "${config.id}"`);
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
            setTimeout(() => void open(), delay);
        });

        // A socket error is always followed by a close event, which owns the retry, this only records the cause,
        // which the close code alone never carries.
        ws.addEventListener("error", () => log("connection error"));
    };

    void open();

    return {
        done,
        stop: () => {
            stopped = true;
            socket?.close(1000, "stopping");
            resolveDone();
        },
    };
};
