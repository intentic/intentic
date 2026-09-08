import { createBackoff } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import { HOST_HEARTBEAT_MS, hostConnectUrl, type HostScopes } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { type DaemonBase, resolveDaemonBase } from "../daemon-base.js";
import { type HostLink, rememberScopes } from "./config.js";
import { createHostRouter } from "./router.js";

/* The one socket, this device's instance of the peer dial (sandbox-contract's peer-dial.ts: the two-phase
 * socket, the handler-before-hello rule, the backoff ladder and the 1008 rule all live there). What is this
 * machine's own is WHERE IT DIALS and what it serves.
 *
 * WHERE IT DIALS is resolved per attempt rather than fixed to the link's public URL (../daemon-base.ts, the
 * same resolver the sync half's watcher uses): the sandbox's own container on this machine's loopback when
 * /health there names the sandbox this link is for, the public URL as the floor. It matters here for a
 * different reason than it does for a Mutagen stream. A socket carries kilobytes, so the edge costs it
 * nothing worth saving; what it costs is REACHABILITY. A sandbox running on this very machine whose tunnel is
 * down — a dev box, an ingress mid-move, an edge answering 502 for an hour — used to read "offline" on its own
 * Devices tab while the sync half of this same process was polling the container a loopback hop away, and
 * every control on that tab hangs on this socket being up. Asked on EVERY attempt, never once at startup,
 * because the answer is exactly what a reconnect is about: the container this socket was on went away, or one
 * appeared where there was none. The ordinary case costs nothing (a loopback port with no listener refuses in
 * under a millisecond), and the one that costs a probe's budget is a hung socket, which is the case worth
 * spending it on. */

/* The two things between this loop and the network, injectable together because a test of WHICH address gets
 * dialled needs to stand in for both: the answer to "where is the daemon" and the socket that answer is
 * handed to. Production wires the real resolver and the runtime's own WebSocket. */
export interface Dial {
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly socket: (url: string) => WebSocket;
}

const realDial: Dial = { resolveBase: resolveDaemonBase, socket: (url) => new WebSocket(url) };

export const connect = (config: HostLink, version: string, log: Log, dial: Dial = realDial): PeerLink => {
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
                 * device answered to exactly one sandbox and is wrong now that it answers to a list: the
                 * router has no idea which of them pushed. The connection does, because it IS one link, so the
                 * persistence moved to the side that holds the identity. Best-effort and unawaited for the
                 * reason it always was: the live grant above is already enforcing. */
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
                // The loopback case is said, because it is the one a reader of this log cannot infer from the
                // link's own address, and the one that explains a machine that is "connected" with its tunnel down.
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
