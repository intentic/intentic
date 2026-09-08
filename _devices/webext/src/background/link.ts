import { createBackoff } from "@intentic/base/async";
import { WEBEXT_HEARTBEAT_MS, webextConnectUrl } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { createWebExtRouter } from "./router.js";
import { store } from "./store.js";

// This browser's peer-dial socket (sandbox-contract/peer-dial.ts), shaped by the MV3 service worker's lifetime
// (Chrome kills it after ~30s idle):
// - WebSocket traffic + a 20s sandbox heartbeat keep an established link's worker alive.
// - A dead worker takes the socket with it; an alarm (main.ts) redials on a timer instead.
// - No durable state lives here: token, scopes, pause switch are all in storage; pairing is read fresh per attempt.

let link: PeerLink | undefined;

export const linkState = (): "open" | "connecting" | "closed" => link?.state() ?? "closed";

const version = (): string => chrome.runtime.getManifest().version;

// Opens the socket if not already open; idempotent, so every entry point (install, startup, the keepalive alarm,
// finishing a pairing) can call it without coordinating.
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
        // The sandbox revoked this browser: forgetting the pairing is honest, since a stored token that can't be used
        // would look connected in the popup and never be. Logged so the person knows why.
        revoked: () => {
            void store.append({ at: Date.now(), tool: "connection", detail: "the sandbox revoked this browser", ok: false });
            void store.forgetSandbox();
        },
    });
};

// Drops the connection now (unpaired, or sandbox forgotten); deliberately doesn't clear storage, since callers
// mean different things by "disconnect".
export const closeLink = (): void => {
    link?.stop("unpaired");
    link = undefined;
};
