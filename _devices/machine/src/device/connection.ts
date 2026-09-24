import { createBackoff } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { HOST_HEARTBEAT_MS, hostConnectUrl, type DeviceScopes } from "@intentic/sandbox-contract";
import { dialPeer, PEER_LINK_BACKOFF, peerLinkSilenceMs, type PeerLink } from "@intentic/sandbox-contract/peer-dial";
import { RPCHandler } from "@orpc/server/websocket";
import { type DaemonBase, resolveDaemonBase } from "../daemon-base.js";
import { type HostLink, rememberScopes, removeLinks } from "./config.js";
import { type Indicator, machineIndicator } from "./indicator.js";
import { createHostRouter } from "./router.js";

// This device's one instance of sandbox-contract's peer-dial (the socket, handler-before-hello, backoff, the
// 1008 rule). What's local: WHERE it dials, resolved per attempt (../daemon-base.ts) so a sandbox on this
// machine's own loopback is reached even when its public tunnel is down, and what it serves.

// The two things between this agent and the network, injectable together: where the daemon is, and the socket
// that answer is handed to. Production wires the real resolver and the runtime's own WebSocket.
export interface Dial {
    readonly resolveBase: (sandboxUrl: string) => Promise<DaemonBase>;
    readonly socket: (url: string) => WebSocket;
}

const realDial: Dial = { resolveBase: resolveDaemonBase, socket: (url) => new WebSocket(url) };

// What a revoked link is dropped with; the resident's next pass then closes nothing more, since the loop already ended.
const forgetLink = async (sandboxUrl: string): Promise<void> => void (await removeLinks(sandboxUrl));

export const connect = (
    config: HostLink,
    version: string,
    log: Log,
    dial: Dial = realDial,
    forget = forgetLink,
    indicator: Indicator = machineIndicator(),
): PeerLink => {
    // Every line this link writes names the sandbox it is about. One agent holds a link per sandbox and the dial
    // agent's own complaints carry no address, so a machine with five links wrote "disconnected (1002); 7172 failed
    // attempts" for two days without ever saying whose — and nothing in the log could tell the dead ones apart.
    const linkLog: Log = (message) => log(`${config.sandboxUrl}: ${message}`);
    // The live grant, replaced by the sandbox's `setScopes` on every connect, so a scope turned off is enforced
    // from the new session's first call.
    let scopes: DeviceScopes = config.scopes;
    // The socket this link is on now.
    let held: WebSocket | undefined;
    const handler = new RPCHandler(
        createHostRouter({
            sandboxUrl: config.sandboxUrl,
            scopes: () => scopes,
            setScopes: (next) => {
                scopes = next;
                // The persistence for this link's cache alone, written by the connection, which owns the link's entry
                // in the file. Unawaited: the live grant above already enforces.
                void rememberScopes(config.sandboxUrl, next).catch((error: unknown) =>
                    linkLog(`could not save the permissions it pushed (${errorMessage(error)}); this connection enforces them regardless.`),
                );
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
                // carry. The address itself comes from the prefix above, which every line of this link's carries.
                said: `connected${local ? ` over loopback (${base})` : ""} as "${config.id}"`,
            };
        },
        hello: () => ({ type: "hello", token: config.token, version }),
        attach: (ws) => {
            held = ws;
            // A link that is gone drives nothing; only its latest socket speaks for it, as one abandoned may close late.
            ws.addEventListener("close", () => {
                if (held === ws) {
                    indicator.release(config.sandboxUrl);
                }
            });
            handler.upgrade(ws);
        },
        backoff: createBackoff(PEER_LINK_BACKOFF),
/* The deadline that makes a dead link NOTICEABLE, and on this door it is the one that matters most. */
        silenceMs: peerLinkSilenceMs(HOST_HEARTBEAT_MS),
        log: linkLog,
        // 1008 is the sandbox having read its enrollments and not found this one, so the link is dropped rather than redialled.
        revoked: () => {
            linkLog("the sandbox refused this device's enrollment: it was revoked there, so this link is dropped. Connect again from the sandbox to restore it.");
            void forget(config.sandboxUrl).catch((error: unknown) => linkLog(`could not drop the revoked link (${String(error)})`));
        },
    });
};
