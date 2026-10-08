import { z } from "zod";
import { ActivityStatusSchema } from "../../schemas/activity.js";
import { rawRouteUrl } from "../raw/raw-routes.js";

// Wire between the daemon and an extension's realtime-listener gateway (ext-discord, ext-slack, ext-telegram,
// ext-whatsapp, ext-imap, ext-google-workspace): the four /listeners/:provider routes (state, dispatch, failure,
// status). Shared here so both ends compile against one declaration.

// The path of one of the four listener routes for a provider, built from RAW_ROUTES so the gateway and the daemon
// cannot spell it two ways.
export const listenerRouteUrl = (route: "state" | "dispatch" | "failure" | "status", provider: string): string =>
    route === "state"
        ? rawRouteUrl("GET /listeners/{provider}/state", { provider })
        : rawRouteUrl(`POST /listeners/{provider}/${route}`, { provider });

// The reconcile feed GET /listeners/<provider>/state answers: the enabled automations listening to this provider and
// the connectors the asking extension contributes, each with its whole config, secrets included, since the gateway
// connects with them. The gateway reads only an automation's id and whether it is on; a connector's config is the
// connector's own shape, which the connector reads itself.
export const ListenerStateSchema = z.object({
    automations: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
    connectors: z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) })),
});
export type ListenerState = z.infer<typeof ListenerStateSchema>;

// One prior message a gateway hands over with a mention, oldest first; `self` marks one of our own bots' posts, so the
// model recognizes its earlier replies.
export const ListenerHistoryEntrySchema = z.object({
    author: z.object({ id: z.string(), name: z.string() }),
    content: z.string(),
    timestamp: z.string(),
    self: z.boolean().optional(),
});
export type ListenerHistoryEntry = z.infer<typeof ListenerHistoryEntrySchema>;

// One normalized inbound event: the JSON body a realtime source POSTs to /listeners/<provider>/dispatch. A zod schema
// since it's parsed from untrusted gateway input; `provider` and `type` are open strings, not a core enum.
export const ListenerMessageSchema = z.object({
    provider: z.string().min(1),
    type: z.string().min(1),
    id: z.string(),
    channelId: z.string(),
    // `id` is what the service vouches for and what sender rules match; `name` is display only. `groups` are the
    // service's own group ids on this sender (Discord role ids), absent on a source without them.
    author: z.object({ id: z.string(), name: z.string(), groups: z.array(z.string()).optional() }),
    content: z.string(),
    // The message is addressed to us, by each provider's own rule: an @mention of or reply to one of our bots, a direct
    // message, a Slack thread we already answered in, or mail whose To line holds the connected address. Voice events
    // never set it.
    mentioned: z.boolean().optional(),
    // CI pipeline event: the ref it ran on. Top-level, not in `extra`, since the dispatcher matches triggers on it.
    branch: z.string().optional(),
    // Prior channel messages fetched when tagged; top-level so it reaches the model but skips the activity feed.
    history: z.array(ListenerHistoryEntrySchema).optional(),
    timestamp: z.string(),
    // Provider-specific fields, for example:
    // - discord message: guildId, attachments
    // - slack message: threadTs, teamId, attachments
    // - telegram message: chatType, messageId, chatTitle, messageThreadId, attachments
    // - whatsapp message: chatType, chatName, replyTo, attachments
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
// holds no provider connection to probe itself. Extends ActivityStatus with each unpaired capability's pairing ceremony
// by id.
export const ListenerStatusSchema = ActivityStatusSchema.extend({
    pairing: z.record(z.string(), ListenerPairingSchema).optional(),
});
export type ListenerStatus = z.infer<typeof ListenerStatusSchema>;

// A connection's place in the reconcile lifecycle: `idle` is up but intentionally holding nothing (no enabled
// automation), `pairing` is up but waiting on an uncompleted credential ceremony; the rest are the connect loop.
export type ListenerGatewayPhase = "idle" | "ready" | "pairing" | "connecting" | "disconnected";
