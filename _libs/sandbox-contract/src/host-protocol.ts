import { z } from "zod";
import { HostFactsSchema, HostScopesSchema } from "./schemas.js";

/* The /system/hosts/connect WebSocket wire protocol — the one socket between a user's own computer and this
 * sandbox, shared by the daemon's hub (hosts/host-hub.ts) and the @intentic/host agent so the two can't drift.
 *
 * The machine DIALS US and keeps one socket open: it sits behind NAT, a corporate proxy and a sleeping lid, so
 * nothing can dial it. Everything therefore multiplexes over this one connection, and the frame set is
 * deliberately tiny:
 *
 *   hello  (machine → daemon)  once, on open: who am I, what am I, which binary version.
 *   scopes (daemon → machine)  the grant, pushed on connect and again whenever the owner edits the capability.
 *                              The machine ENFORCES it; the daemon never checks a scope itself, so tightening a
 *                              scope reaches the enforcement point in one frame rather than at the next restart.
 *   rpc    (both ways)         one MCP JSON-RPC message, verbatim. The daemon does not interpret it — the tool
 *                              surface lives in the machine's binary, so a machine that learns a new tool needs
 *                              no daemon release. `payload` is therefore `unknown`, on purpose.
 *   ping/pong (both ways)      liveness against idle-reaping tunnels, and how "online" stays honest.
 *
 * Zod schemas rather than plain types (the terminal protocol's choice): these frames cross a trust boundary in
 * the direction that matters — a machine's frame lands in the daemon — and they are rare (a tool call, not a
 * keystroke), so validating each one costs nothing worth measuring. */

// The MCP protocol revision the machine's tool server implements. Shared because the daemon answers the
// handshake ITSELF when the machine is asleep (hosts/host.routes.ts) — two spellings of this would mean an
// offline machine negotiating a different protocol than the same machine awake.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const HostHelloSchema = z.object({
    type: z.literal("hello"),
    /* The machine's enrollment token — in the FIRST FRAME, never in the URL. A WebSocket has no headers to put
     * it in, and the obvious `?token=` would write a durable key to somebody's laptop into Cloudflare's edge
     * logs, the connector's logs and every proxy in between (the reasoning that moved the browser's upgrades
     * onto one-shot tickets — auth/ws-tickets.ts). A frame is body, not URL, so it is logged nowhere. Until this
     * arrives the socket is anonymous and short-lived: the daemon closes it in seconds if it never does. */
    token: z.string(),
    // The @intentic/host build the machine is running — surfaced per machine so an old binary is visible rather
    // than mysteriously missing a tool.
    version: z.string(),
    facts: HostFactsSchema,
});

export const HostRpcFrameSchema = z.object({ type: z.literal("rpc"), payload: z.unknown() });
export const HostPingSchema = z.object({ type: z.literal("ping") });
export const HostPongSchema = z.object({ type: z.literal("pong") });
export const HostScopesFrameSchema = z.object({ type: z.literal("scopes"), scopes: HostScopesSchema });

// What the daemon accepts from a machine.
export const HostClientFrameSchema = z.discriminatedUnion("type", [HostHelloSchema, HostRpcFrameSchema, HostPingSchema, HostPongSchema]);
export type HostClientFrame = z.infer<typeof HostClientFrameSchema>;

// What a machine accepts from the daemon.
export const HostServerFrameSchema = z.discriminatedUnion("type", [HostScopesFrameSchema, HostRpcFrameSchema, HostPingSchema, HostPongSchema]);
export type HostServerFrame = z.infer<typeof HostServerFrameSchema>;

// The URL the machine's agent dials, given the sandbox's public URL. Carries no credential — the token rides
// the hello frame. One place builds it, so the agent and the daemon route can't disagree about where it lives.
export const hostConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/hosts/connect`;
