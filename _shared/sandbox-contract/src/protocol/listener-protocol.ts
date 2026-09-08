import { z } from "zod";
import { ActivityStatusSchema } from "../schemas/activity.js";

// Wire between the daemon and an extension's realtime-listener gateway (ext-discord, ext-slack, ext-telegram,
// ext-whatsapp, ext-imap): the four /listeners/:provider routes (state, dispatch, failure, status). Shared here so both
// ends compile against one declaration.

// One normalized inbound event: the JSON body a realtime source POSTs to /listeners/<provider>/dispatch. A zod schema
// since it's parsed from untrusted gateway input; `provider` and `type` are open strings, not a core enum.
export const ListenerMessageSchema = z.object({
    provider: z.string().min(1),
    type: z.string().min(1),
    id: z.string(),
    channelId: z.string(),
    author: z.object({ id: z.string(), name: z.string() }),
    content: z.string(),
    // Discord only: the message @mentions or replies to one of our bots; voice events never set it.
    mentioned: z.boolean().optional(),
    // CI pipeline event: the ref it ran on. Top-level, not in `extra`, since the dispatcher matches triggers on it.
    branch: z.string().optional(),
    // Prior channel messages fetched when tagged; top-level so it reaches the model but skips the activity feed.
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
    // Provider-specific fields:
    // - discord message: guildId, attachments
    // - voice_utterance: path
    // - voice_transcript: path, participants, durationSeconds
    extra: z.record(z.string(), z.unknown()).optional(),
});
export type ListenerMessage = z.infer<typeof ListenerMessageSchema>;

// One ndjson frame of a /listeners/<provider>/dispatch?stream=1 response: a text delta, a failure sentence, or a
// terminal marker. A type, not a schema, since only the daemon produces these.
export interface ListenerDispatchFrame {
    readonly automationId: string;
    readonly delta?: string;
    // The turn's failure, forwarded verbatim since a gateway delivers it into the owner's own channel.
    readonly failed?: string;
    readonly end?: boolean;
}

// Where a device-linking ceremony stands (whatsapp), reported per status tick; every state here means not yet paired.
// `since` stamps the current code's age, since WhatsApp reissues a fresh one on each reopen.
export const ListenerPairingSchema = z.object({
    // waiting: socket up, no code yet (or the last one died with its socket)
    // code: `code` is live, type it on the phone
    // failed: `detail` says what WhatsApp refused
    state: z.enum(["waiting", "code", "failed"]),
    code: z.string().optional(),
    detail: z.string().optional(),
    since: z.number().optional(),
});
export type ListenerPairing = z.infer<typeof ListenerPairingSchema>;

// Push-based status: a gateway POSTs its connection/voice snapshot to /listeners/<provider>/status, since the daemon
// holds no provider connection to probe itself. Extends ActivityStatus with whisper's voice-pending flag and each
// unpaired capability's pairing ceremony by id.
export const ListenerStatusSchema = ActivityStatusSchema.extend({
    whisperReady: z.boolean().optional(),
    pairing: z.record(z.string(), ListenerPairingSchema).optional(),
});
export type ListenerStatus = z.infer<typeof ListenerStatusSchema>;

// A connection's place in the reconcile lifecycle: `idle` is up but intentionally holding nothing (no enabled
// automation), `pairing` is up but waiting on an uncompleted credential ceremony; the rest are the connect loop.
export type ListenerGatewayPhase = "idle" | "ready" | "pairing" | "connecting" | "disconnected";
