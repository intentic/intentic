import { z } from "zod";

// The handshake on /system/hosts/connect, the one message on this socket that isn't oRPC. Proving whose socket it is
// can't itself be an oRPC call, so the machine's first frame is plain JSON; the daemon verifies it and only then
// attaches the typed link. Anything before that link exists is this frame or a closed socket.

/* HOW OFTEN THIS DOOR PINGS A CONNECTED MACHINE, read by both sides of the socket. */
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
