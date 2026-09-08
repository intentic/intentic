import { createBackoff } from "@intentic/base/async";
import { WEBEXT_HEARTBEAT_MS, webextConnectUrl } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { createWebExtRouter } from "./router.js";
import { store } from "./store.js";

/* THE ONE SOCKET, this browser's instance of the peer dial (sandbox-contract's peer-dial.ts owns the two-phase
 * socket, the handler-before-hello rule, the backoff ladder and the 1008 rule).
 *
 * WHAT IS DIFFERENT FROM THE MACHINE AGENT'S VERSION is the lifetime, and it decides the shape. An MV3 service
 * worker is not a process: Chrome kills it after ~30 seconds of inactivity and rebuilds it on the next event.
 * Three consequences, all of them visible below:
 *
 *   · WebSocket traffic counts as activity, and the sandbox heartbeats every 20 seconds, so an established
 *     link keeps its own worker alive. This is why the daemon's heartbeat is 20s and not the machine hub's 30.
 *   · A worker that dies anyway takes the socket with it. So the reconnect cannot live only in the loop's own
 *     retry — an alarm (main.ts) calls `ensureLink` on a timer, and a fresh worker re-dials from storage.
 *   · Nothing may be held in module state that matters. The token, the scopes and the pause switch are all in
 *     storage; what is here is only the live link, which is meaningless once the worker is gone. So the
 *     pairing is READ PER ATTEMPT: a code redeemed while the loop was waiting on its ladder dials the new
 *     sandbox, and a pairing forgotten in the meantime ends the loop. */

let link: PeerLink | undefined;

export const linkState = (): "open" | "connecting" | "closed" => link?.state() ?? "closed";

const version = (): string => chrome.runtime.getManifest().version;

/* Open the socket if it is not already open. Idempotent, and every entry point calls it: install, startup, the
 * keepalive alarm, and finishing a pairing. A connector whose reconnection depends on one clever place is a
 * connector that is offline whenever that place did not run. */
export const ensureLink = async (): Promise<void> => {
    if (link !== undefined && link.state() !== "closed") {
        return;
    }
    if ((await store.sandbox()) === undefined) {
        return;
    }
    const handler = new RPCHandler(createWebExtRouter());
    link = dialPeer<WebSocket>({
        open: async () => {
            const sandbox = await store.sandbox();
            return sandbox === undefined ? undefined : { socket: new WebSocket(webextConnectUrl(sandbox.url)) };
        },
        hello: async () => ({ type: "hello", token: (await store.sandbox())?.token ?? "", version: version() }),
        attach: (ws) => handler.upgrade(ws),
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* A socket the sandbox has gone quiet on is redialled rather than held: the alarm above only re-dials a
         * link that reads `closed`, so a half-open one would look connected to every entry point there is. */
        silenceMs: peerLinkSilenceMs(WEBEXT_HEARTBEAT_MS),
        // Nothing reads a log here: the popup's activity list is written by the calls themselves.
        log: () => undefined,
        /* The sandbox revoked this browser. Forgetting the pairing is the honest response: the token is now
         * worthless, and a stored credential that cannot be used is a thing that looks connected in the popup
         * and never will be. The line in the activity log is what tells the person why. */
        revoked: () => {
            void store.append({ at: Date.now(), tool: "connection", detail: "the sandbox revoked this browser", ok: false });
            void store.forgetSandbox();
        },
    });
};

// Drop the connection now: the person unpaired, or the sandbox was forgotten. Deliberately does not clear
// storage — the caller decides what "disconnect" means, and both callers mean different things by it.
export const closeLink = (): void => {
    link?.stop("unpaired");
    link = undefined;
};
