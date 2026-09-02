import { createBackoff } from "@intentic/base/async";
import { webextConnectUrl } from "@intentic/sandbox-contract";
import { RPCHandler } from "@orpc/server/websocket";
import { createWebExtRouter } from "./router.js";
import { store } from "./store.js";

/* THE ONE SOCKET. This browser dials the sandbox and keeps the connection open; everything the agent asks for
 * arrives on it as an oRPC call against `webextContract`, and every answer goes back the same way.
 *
 * OUTBOUND ONLY, which is the entire networking story: no port is opened, no router configured, no VPN joined.
 * A laptop on hotel wifi behind a corporate proxy holds this connection because it is an ordinary outbound
 * wss://, the same thing every other tab is already doing.
 *
 * WHAT IS DIFFERENT FROM THE MACHINE AGENT'S VERSION OF THIS FILE is the lifetime, and it decides the shape.
 * An MV3 service worker is not a process: Chrome kills it after ~30 seconds of inactivity and rebuilds it on
 * the next event. Three consequences, all of them visible below:
 *
 *   · WebSocket traffic counts as activity, and the sandbox heartbeats every 20 seconds, so an established
 *     link keeps its own worker alive. This is why the daemon's heartbeat is 20s and not the machine hub's 30.
 *   · A worker that dies anyway takes the socket with it. So the reconnect cannot live only in a `close`
 *     handler — an alarm (main.ts) calls `ensureLink` on a timer, and a fresh worker re-dials from storage.
 *   · Nothing may be held in module state that matters. The token, the scopes and the pause switch are all in
 *     storage; what is here is only the live socket and its backoff, both of which are meaningless once the
 *     worker is gone. */

// Backoff bounds. The first retry is fast because the overwhelmingly common cause is a sandbox restart, which
// takes seconds; the ceiling is low because the alarm will re-drive this anyway. The ladder is the shared one
// (@intentic/base's createBackoff): a link that held for a minute redials at the floor, one that opened and
// died at once keeps climbing.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 60_000;
// The daemon closes with this when the token is not enrolled: a decision, not a fault, and one that never heals.
const UNAUTHORIZED = 1008;

let socket: WebSocket | undefined;
let openedAt: number | undefined;
const ladder = createBackoff({ floorMs: RETRY_MIN_MS, capMs: RETRY_MAX_MS, stableMs: STABLE_MS });
let dialling = false;

export const linkState = (): "open" | "connecting" | "closed" =>
    socket?.readyState === WebSocket.OPEN ? "open" : socket?.readyState === WebSocket.CONNECTING || dialling ? "connecting" : "closed";

const version = (): string => chrome.runtime.getManifest().version;

/* Open the socket if it is not already open. Idempotent, and every entry point calls it: install, startup, the
 * keepalive alarm, and finishing a pairing. A connector whose reconnection depends on one clever place is a
 * connector that is offline whenever that place did not run. */
export const ensureLink = async (): Promise<void> => {
    if (socket !== undefined && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const sandbox = await store.sandbox();
    if (sandbox === undefined) {
        return;
    }
    dialling = true;
    const handler = new RPCHandler(createWebExtRouter(version()));
    const ws = new WebSocket(webextConnectUrl(sandbox.url));
    socket = ws;

    ws.addEventListener("open", () => {
        openedAt = Date.now();
        dialling = false;
        /* The handler is attached BEFORE the hello goes out: the sandbox may call the moment it has verified
         * the token, and a race there would drop the first `setScopes` — the one call whose loss would leave
         * this browser enforcing a stale grant. */
        handler.upgrade(ws);
        ws.send(JSON.stringify({ type: "hello", token: sandbox.token, version: version() }));
    });

    ws.addEventListener("close", (event) => {
        socket = undefined;
        dialling = false;
        if (event.code === UNAUTHORIZED) {
            /* The sandbox revoked this browser. Forgetting the pairing is the honest response: the token is
             * now worthless, and a stored credential that cannot be used is a thing that looks connected in
             * the popup and never will be. The line in the activity log is what tells the person why. */
            void store.append({ at: Date.now(), tool: "connection", detail: "the sandbox revoked this browser", ok: false });
            void store.forgetSandbox();
            return;
        }
        const delay = ladder.next(openedAt === undefined ? 0 : Date.now() - openedAt);
        openedAt = undefined;
        // A timer in a service worker is not reliable — the worker may be gone before it fires — so this is
        // the fast path and the alarm in main.ts is the one that actually guarantees a retry.
        setTimeout(() => void ensureLink(), delay);
    });

    // A socket error is always followed by a close, which owns the retry.
    ws.addEventListener("error", () => undefined);
};

// Drop the connection now: the person unpaired, or the sandbox was forgotten. Deliberately does not clear
// storage — the caller decides what "disconnect" means, and both callers mean different things by it.
export const closeLink = (): void => {
    socket?.close(1000, "unpaired");
    socket = undefined;
};
