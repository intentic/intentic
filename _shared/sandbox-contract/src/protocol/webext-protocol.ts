import { z } from "zod";

/* The handshake on /system/webext/connect, the ONE message on that socket that is not oRPC.
 *
 * Same two-phase shape as a connected device's (host-protocol.ts) and for the same reason: the daemon has
 * nothing to call until it knows whose socket this is, so the proof cannot itself be an oRPC call. The browser
 * extension's first frame carries its enrollment token, the daemon resolves WHICH capability it belongs to, and
 * from that message on every byte is `webextContract` with the EXTENSION serving.
 *
 * WHY A SEPARATE PROTOCOL FROM host's, when the frame is the same two fields: because the thing on the other
 * end is not a device. It has no shell, no filesystem and no screen; what it has is tabs, origins the person
 * granted one at a time, and a human watching every click. Sharing the host's schema would have meant a card of
 * switches that mean nothing (`roots`, `sandboxRemove`) and an agent told about a home directory it cannot
 * reach. The two connectors are siblings, not one connector with a flag. */

export const WebExtHelloSchema = z.object({
    type: z.literal("hello"),
    /* The extension's enrollment token, in the FIRST FRAME, never in the URL: a WebSocket has no headers, and
     * `?token=` would write a durable key into every proxy log between a browser and the sandbox. Until this
     * arrives the socket is anonymous and short-lived. */
    token: z.string(),
    // The extension build the browser is running. Surfaced per connection so an old, un-updated extension is
    // visible rather than mysteriously missing a tool. What the BROWSER is (`describe`) is pulled over the
    // typed link a moment later, so there is one definition of those facts rather than two.
    version: z.string(),
});
export type WebExtHello = z.infer<typeof WebExtHelloSchema>;
