import { createBackoff } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import { HOST_HEARTBEAT_MS, hostConnectUrl, type HostScopes } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { type DaemonBase, resolveDaemonBase } from "../daemon-base.js";
import { type HostLink, rememberScopes } from "./config.js";
import { createHostRouter } from "./router.js";

// This device's one instance of sandbox-contract's peer-dial (the socket, handler-before-hello, backoff, the
// 1008 rule). What's local: WHERE it dials, resolved per attempt (../daemon-base.ts) so a sandbox on this
// machine's own loopback is reached even when its public tunnel is down, and what it serves.

// The two things between this loop and the network, injectable together: where the daemon is, and the socket
// that answer is handed to. Production wires the real resolver and the runtime's own WebSocket.
export interface Dial {
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly socket: (url: string) => WebSocket;
}

const realDial: Dial = { resolveBase: resolveDaemonBase, socket: (url) => new WebSocket(url) };

export const connect = (config: HostLink, version: string, log: Log, dial: Dial = realDial): PeerLink => {
    // The live grant, replaced by the sandbox's `setScopes` on every connect, so a scope turned off is enforced
    // from the new session's first call.
    let scopes: HostScopes = config.scopes;
    const handler = new RPCHandler(
        createHostRouter({
            scopes: () => scopes,
            setScopes: (next) => {
                scopes = next;
                // The persistence for this link's cache alone: the router doesn't know which of several sandboxes
                // pushed, so
                // the connection, which owns the identity, writes it. Unawaited: the live grant above already enforces.
                void rememberScopes(config.sandboxUrl, next);
            },
            log,
        }),
    );

    return dialPeer<WebSocket>({
        open: async (signal) => {
            const { base, local } = await dial.resolveBase(config.sandboxUrl);
            if (signal.aborted) {
                return undefined;
            }
            return {
                socket: dial.socket(hostConnectUrl(base)),
                // The loopback case is logged; it's the one fact about this connection the link's own address doesn't
                // carry.
                said: `connected to ${config.sandboxUrl}${local ? ` over loopback (${base})` : ""} as "${config.id}"`,
            };
        },
        hello: () => ({ type: "hello", token: config.token, version }),
        attach: (ws) => handler.upgrade(ws),
        backoff: createBackoff(PEER_LINK_BACKOFF),
        /* The deadline that makes a dead link NOTICEABLE, and on this door it is the one that matters most:
         * the address resolved above is often a loopback hop through a port relay that outlives the container
         * behind it, which is precisely the socket that dies without a close frame (peer-dial.ts says what that
         * cost). Timed off the sandbox's own heartbeat, so silence here means the sandbox, not the network. */
        silenceMs: peerLinkSilenceMs(HOST_HEARTBEAT_MS),
        log,
        revoked: () =>
            log("the sandbox refused this device's enrollment: it was revoked there. Run `intentic-machine device uninstall` to clean up, or connect again from the sandbox."),
    });
};
