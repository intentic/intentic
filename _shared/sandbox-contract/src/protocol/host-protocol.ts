import { z } from "zod";

// The handshake on /system/hosts/connect, the one message on this socket that isn't oRPC. Proving whose socket it is
// can't itself be an oRPC call, so the machine's first frame is plain JSON; the daemon verifies it and only then
// attaches the typed link. Anything before that link exists is this frame or a closed socket.

// Shared with the daemon's peer bridge, which answers the handshake itself when the machine is asleep.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/* HOW OFTEN THIS DOOR PINGS A CONNECTED MACHINE, read by both sides of the socket: the daemon's hub pings on
 * it (hosts/host-peer.ts) and the agent presumes a link dead after a few of them pass in silence
 * (peer-dial.ts's peerLinkSilenceMs). Frequent enough to stay inside the idle timeout of every tunnel and proxy
 * in the path, and it is the failure of a ping that tells the daemon a lid closed without a close frame ever
 * arriving. One number, because the two sides disagreeing about it is a device that is either dropped while
 * healthy or believed alive for as long as its socket stays open. */
export const HOST_HEARTBEAT_MS = 30_000;

export const HostHelloSchema = z.object({
    type: z.literal("hello"),
    // Sent in the first frame, never the URL (a WebSocket has no headers, and a URL gets logged everywhere).
    token: z.string(),
    // The build the machine runs, surfaced so an old binary is visible rather than mysteriously missing a tool.
    version: z.string(),
});
export type HostHello = z.infer<typeof HostHelloSchema>;

// The URL the machine's agent dials, given the sandbox's public URL. Carries no credential (the token rides the hello
// frame); one place builds it, so the agent and the daemon route can't disagree.
export const hostConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/hosts/connect`;
