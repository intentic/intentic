import { createBackoff } from "@intentic/base/async";
import { WEBEXT_HEARTBEAT_MS, webextConnectUrl } from "@intentic/sandbox-contract/webext";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { createWebExtRouter } from "./router.js";
import { type SandboxKey, sandboxKey, sandboxName, store } from "./store.js";

// This browser's peer-dial sockets (sandbox-contract/peer-dial.ts), one per paired sandbox, shaped by the MV3 service
// worker's lifetime (Chrome kills it after ~30s idle):
// - WebSocket traffic + a 20s sandbox heartbeat keep an established link's worker alive.
// - A dead worker takes the sockets with it; an alarm (main.ts) redials on a timer instead.
// - No durable state lives here: tokens, scopes, pause switch are all in storage; each pairing is read fresh per attempt.
// Each socket serves its own sandbox only: its router knows which sandbox it answers (router.ts), so a tool called over
// it acts with that sandbox's switches and reports to that sandbox alone.

export type LinkState = "open" | "connecting" | "closed";

const links = new Map<SandboxKey, PeerLink>();

export const linkState = (key: SandboxKey): LinkState => links.get(sandboxKey(key))?.state() ?? "closed";

const version = (): string => chrome.runtime.getManifest().version;

const dial = (key: SandboxKey): PeerLink => {
    const handler = new RPCHandler(createWebExtRouter(key));
    const link: PeerLink = dialPeer<WebSocket>({
        open: async () => {
            const sandbox = await store.sandbox(key);
            return sandbox === undefined ? undefined : { socket: new WebSocket(webextConnectUrl(sandbox.url)) };
        },
        hello: async () => ({ type: "hello", token: (await store.sandbox(key))?.token ?? "", version: version() }),
        attach: (ws) => handler.upgrade(ws),
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* A socket the sandbox has gone quiet on is redialled rather than held: the alarm only re-dials a link that reads `closed`. */
        silenceMs: peerLinkSilenceMs(WEBEXT_HEARTBEAT_MS),
        // Nothing reads a log here: the popup's activity list is written by the calls themselves.
        log: () => undefined,
        // The sandbox revoked this browser: forgetting that pairing is honest, since a stored token that can't be used
        // would look connected in the popup and never be. Logged so the person knows why. The other sandboxes stay.
        revoked: () => {
            if (links.get(key) === link) {
                links.delete(key);
            }
            void (async () => {
                const sandbox = await store.sandbox(key);
                const who = sandbox === undefined ? "The sandbox" : sandboxName(sandbox);
                await store.append({ at: Date.now(), tool: "connection", detail: `${who} disconnected this browser`, ok: false, sandbox: key });
                await store.forgetSandbox(key);
            })();
        },
    });
    return link;
};

const reconcile = async (): Promise<void> => {
    const paired = new Set((await store.sandboxes()).map((sandbox) => sandboxKey(sandbox.url)));
    for (const [key, link] of links) {
        if (!paired.has(key)) {
            link.stop("unpaired");
            links.delete(key);
        }
    }
    for (const key of paired) {
        const link = links.get(key);
        if (link === undefined || link.state() === "closed") {
            link?.stop("redial");
            links.set(key, dial(key));
        }
    }
};

// Opens a socket to every paired sandbox that has none open, and drops the socket of one no longer paired; idempotent,
// so every entry point (install, startup, the keepalive alarm, finishing a pairing) can call it without coordinating.
// One pass at a time: two passes reading the list together would each dial the same sandbox, and the socket of the one
// that lost would live on with nothing holding it.
let ensuring: Promise<void> = Promise.resolve();
export const ensureLinks = async (): Promise<void> => {
    ensuring = ensuring.then(reconcile, reconcile);
    await ensuring;
};

// Drops one sandbox's connection now (unpaired, or re-paired with a fresh token); deliberately doesn't clear storage,
// since callers mean different things by "disconnect".
export const closeLink = (key: SandboxKey): void => {
    links.get(sandboxKey(key))?.stop("unpaired");
    links.delete(sandboxKey(key));
};
