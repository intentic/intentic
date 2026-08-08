import { z } from "zod";
import { ActivityStatusSchema } from "./schemas.js";

/* The wire between the daemon and an extension's realtime-listener GATEWAY process (ext-discord, ext-slack,
 * ext-telegram, ext-whatsapp, ext-imap): the four provider-scoped routes app.ts mounts under
 * /listeners/:provider — state, dispatch, failure, status. These shapes used to live daemon-side only, with
 * every gateway hand-writing its own copy of the payloads as untyped literals; a field rename broke five
 * producers silently. They live in the contract now so BOTH ends compile against one declaration — the daemon
 * parses with the schemas, the gateways (via @intentic/connector-runtime) type against the inferred types. */

// One normalized inbound event — serialized as a JSON line in the automation's payload, and the JSON body a
// realtime source POSTs to /listeners/<provider>/dispatch. A zod schema (not a bare interface) because it's
// parsed from an extension gateway's request; `provider` and `type` are open strings — the source is
// extension-declared (contributes.listener), not a core enum.
export const ListenerMessageSchema = z.object({
    provider: z.string().min(1),
    type: z.string().min(1),
    id: z.string(),
    channelId: z.string(),
    author: z.object({ id: z.string(), name: z.string() }),
    content: z.string(),
    // Discord message: it @mentions one of our bots or replies to a bot's message. Voice events never set it.
    mentioned: z.boolean().optional(),
    // CI pipeline event: the ref it ran on. Top-level rather than inside `extra` for the same reason
    // `mentioned` is — the dispatcher MATCHES on it, and a narrowing axis the trigger can name has to be
    // a field of the message rather than a key in a provider's opaque bag.
    branch: z.string().optional(),
    // Prior channel messages (chronological) fetched when a bot is tagged, so the agent can reason about why.
    // Kept a top-level field (not in `extra`) so it reaches the model's payload but stays out of the activity
    // feed, which logs only content/extra.
    history: z
        .array(
            z.object({
                author: z.object({ id: z.string(), name: z.string() }),
                content: z.string(),
                timestamp: z.string(),
                self: z.boolean().optional(),
            }),
        )
        .optional(),
    timestamp: z.string(),
    // Provider-specific fields (discord message: guildId, attachments; voice_utterance: path;
    // voice_transcript: path, participants, durationSeconds).
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ListenerMessage = z.infer<typeof ListenerMessageSchema>;

// One ndjson frame of a /listeners/<provider>/dispatch?stream=1 response — a text delta for one automation's
// reply, the provider's own failure sentence, or that automation's terminal marker. A type, not a schema: the
// DAEMON produces these (listener.routes.ts), so nothing parses them from untrusted input.
export interface ListenerDispatchFrame {
    readonly automationId: string;
    readonly delta?: string;
    // The turn refused or broke, in the provider's own words — forwarded verbatim because a gateway delivers
    // into the owner's own channel, where the actual sentence is the useful thing.
    readonly failed?: string;
    readonly end?: boolean;
}

// Push-based listener status: a gateway process POSTs its live connection/voice snapshot to
// /listeners/<provider>/status, and the activity route reads it from there — the daemon holds no provider
// connection of its own to probe. The body IS the ActivityStatus the /activity/status probe used to build from
// in-process discord singletons, plus the per-gateway extras that ride the same channel: whether whisper is
// present (discord's voice-pending signal) and live pairing codes by capability id (whatsapp's link-a-device
// ceremony — the capability card renders the code as its pending detail).
export const ListenerStatusSchema = ActivityStatusSchema.extend({
    whisperReady: z.boolean().optional(),
    pairing: z.record(z.string(), z.string()).optional(),
});
export type ListenerStatus = z.infer<typeof ListenerStatusSchema>;

// A connection's place in the reconcile lifecycle, as the status snapshot reports it: `idle` = up but holding
// nothing on purpose (no enabled listener automation to connect for), the other three are the connect loop.
export type ListenerGatewayPhase = "idle" | "ready" | "connecting" | "disconnected";
