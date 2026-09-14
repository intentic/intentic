import { z } from "zod";

// Handshake on /system/webext/connect, the one message on that socket that isn't oRPC, same two-phase shape as
// host-protocol.ts. A separate protocol from host's, since the extension has no shell or filesystem, only tabs and
// origins the person granted one at a time.

/* HOW OFTEN THIS DOOR PINGS A CONNECTED BROWSER, read by both sides of the socket. */
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
