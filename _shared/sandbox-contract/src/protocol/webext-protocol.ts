import { z } from "zod";

// Handshake on /system/webext/connect, the one message on that socket that isn't oRPC, same two-phase shape as
// host-protocol.ts. A separate protocol from host's, since the extension has no shell or filesystem, only tabs and
// origins the person granted one at a time.

/* HOW OFTEN THIS DOOR PINGS A CONNECTED BROWSER, read by both sides of the socket: the daemon's hub pings on
 * it (webext/webext-peer.ts) and the extension presumes a link dead after a few of them pass in silence
 * (peer-dial.ts's peerLinkSilenceMs). Tighter than the machine door's and the number is not a taste: an MV3
 * service worker is killed after 30 seconds of inactivity and WebSocket traffic is what counts as activity, so
 * a heartbeat at or above Chrome's own limit would race the browser into shutting the extension down between
 * beats. One number, because the two sides disagreeing about it is either a browser dropped while healthy or
 * one believed alive for as long as its socket happens to stay open. */
export const WEBEXT_HEARTBEAT_MS = 20_000;

export const WebExtHelloSchema = z.object({
    type: z.literal("hello"),
    // Enrollment token, in the first frame, never the URL: a WebSocket has no headers, and `?token=` would leak into
    // proxy logs.
    token: z.string(),
    // Extension build per connection, so an outdated one is visible rather than mysteriously missing a tool.
    version: z.string(),
});
export type WebExtHello = z.infer<typeof WebExtHelloSchema>;
