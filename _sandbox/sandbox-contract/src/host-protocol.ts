import { z } from "zod";

/* The handshake on /system/hosts/connect, the ONE message that is not oRPC.
 *
 * Everything a connected device is asked lives in `hostContract` (contracts/host.contract.ts), spoken over
 * this socket by oRPC's websocket adapter: the machine hosts the server, the daemon holds the client. But a
 * socket has to prove whose it is before it can be given a typed client, and that proof cannot itself be an
 * oRPC call, the daemon has nothing to call yet, and would be attaching a link to a stranger.
 *
 * So the machine's first act is this frame, in plain JSON. The daemon verifies the token, learns which
 * capability the socket belongs to, and only then attaches the link; from that message on, every byte on the
 * wire is oRPC. Anything arriving before the link exists is either this frame or a closed socket. */

// The MCP protocol revision the machine's tool server implements. Shared because the daemon answers the
// handshake ITSELF when the machine is asleep (hosts/host.routes.ts), two spellings of this would mean an
// offline machine negotiating a different protocol than the same machine awake.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const HostHelloSchema = z.object({
    type: z.literal("hello"),
    /* The machine's enrollment token, in the FIRST FRAME, never in the URL. A WebSocket has no headers to put
     * it in, and the obvious `?token=` would write a durable key to somebody's laptop into Cloudflare's edge
     * logs, the connector's logs and every proxy in between (the reasoning that moved the browser's upgrades
     * onto one-shot tickets, auth/ws-tickets.ts). A frame is body, not URL, so it is logged nowhere. Until this
     * arrives the socket is anonymous and short-lived: the daemon closes it in seconds if it never does. */
    token: z.string(),
    // The @intentic/machine build the machine is running, surfaced per machine so an old binary is visible rather
    // than mysteriously missing a tool. What the machine IS (`describe`) is not here: it is pulled over the
    // typed link a moment later, so there is one definition of those facts rather than two.
    version: z.string(),
});
export type HostHello = z.infer<typeof HostHelloSchema>;

// The URL the machine's agent dials, given the sandbox's public URL. Carries no credential, the token rides
// the hello frame. One place builds it, so the agent and the daemon route can't disagree about where it lives.
export const hostConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/hosts/connect`;
