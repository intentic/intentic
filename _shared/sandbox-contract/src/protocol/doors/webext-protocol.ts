// Named imports rather than the `z` namespace: this module is bundled into the browser extension, where the
// namespace keeps zod's 60 locales (~250 kB) that esbuild can otherwise drop. _devices/webext/scripts/size-budget.mjs holds the ceiling.
import { literal, object, string } from "zod";
import type * as z from "zod";

// Handshake on /system/webext/connect, the one message on that socket that isn't oRPC, same two-phase shape as
// host-protocol.ts. A separate protocol from host's, since the extension has no shell or filesystem, only tabs and
// origins the person granted one at a time.

/* HOW OFTEN THIS DOOR PINGS A CONNECTED BROWSER, read by both sides of the socket. */
export const WEBEXT_HEARTBEAT_MS = 20_000;

export const WebExtHelloSchema = object({
    type: literal("hello"),
    // Enrollment token, in the first frame, never the URL: a WebSocket has no headers, and `?token=` would leak into
    // proxy logs.
    token: string(),
    // Extension build per connection, so an outdated one is visible rather than mysteriously missing a tool.
    version: string(),
});
export type WebExtHello = z.infer<typeof WebExtHelloSchema>;
