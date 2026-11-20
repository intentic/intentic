import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

// castd's JSON messages on a media socket (browser-wire's BrowserMediaServerMessage), read at the boundary by both ends
// of the editor's media path: the decode worker reads `hello`, `pong` and `stats`, and the page reads the rest. Read
// loosely, as useScreencast reads the daemon: a field of a type this build does not expect is absent, and a message of
// a type it does not know is passed over rather than refused.

const maybe = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const MediaAudioSchema = z.object({ codec: z.string(), sampleRate: z.number().positive(), channels: z.number().int().positive() });

export const HelloSchema = z.object({
    type: z.literal(`hello`),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scale: z.number().positive().catch(1),
    codec: z.string(),
    audio: maybe(MediaAudioSchema),
    readOnly: z.boolean().catch(false),
    // castd takes a peer connection on this window (mediaRtc.ts).
    rtc: maybe(z.boolean()),
    // This viewer reaches castd on this computer's loopback: an exact picture where the socket asked for one, and sound
    // with the jitter buffer's lower floor.
    local: maybe(z.boolean()),
});
export type MediaHello = z.infer<typeof HelloSchema>;

const CursorSchema = z.object({
    type: z.literal(`cursor`),
    cursor: z.object({ css: maybe(z.string()), png: maybe(z.string()), hotX: maybe(z.number()), hotY: maybe(z.number()) }),
});

const ClipboardSchema = z.object({
    type: z.literal(`clipboard`),
    content: z.object({ text: maybe(z.string()), html: maybe(z.string()), png: maybe(z.string()) }),
});

const StatsSchema = z.object({
    type: z.literal(`stats`),
    rttMs: maybe(z.number()),
    targetKbps: maybe(z.number()),
    fps: maybe(z.number()),
    queueMs: maybe(z.number()),
});

const PongSchema = z.object({ type: z.literal(`pong`), t: z.number() });
const ErrorSchema = z.object({ type: z.literal(`error`), message: z.string().catch(``) });
// The peer connection's signalling (mediaRtc.ts): castd's answer, and its word that the peer is gone or never was.
const RtcAnswerSchema = z.object({ type: z.literal(`rtcAnswer`), sdp: z.string() });
const RtcClosedSchema = z.object({ type: z.literal(`rtcClosed`), reason: z.string().catch(``) });

const ServerSchema = z.discriminatedUnion(`type`, [
    HelloSchema,
    CursorSchema,
    ClipboardSchema,
    StatsSchema,
    PongSchema,
    ErrorSchema,
    RtcAnswerSchema,
    RtcClosedSchema,
]);
export type MediaServerMessage = z.infer<typeof ServerSchema>;

/** One text frame from castd, or undefined for one this build does not read. */
export const readMediaText = (raw: string): MediaServerMessage | undefined => parseJsonWith(raw, ServerSchema);

/** The browser view socket's `media`: where this window's media socket is, and the token that opens it. */
export const MediaOfferSchema = z.object({ path: z.string().startsWith(`/`), token: z.string().min(1), expiresAt: z.number() });
export type MediaOffer = z.infer<typeof MediaOfferSchema>;

const TokenPayloadSchema = z.object({ ro: z.boolean().catch(false) });

/**
 * Whether a media token opens a read-only socket, read off its payload (castd's README: base64url JSON before the
 * dot). Only a hint for when to dial again: castd checks the token, and its `hello` says what the socket is.
 */
export const tokenReadOnly = (token: string): boolean => {
    const payload = token.split(`.`)[0] ?? ``;
    try {
        const json = atob(payload.replaceAll(`-`, `+`).replaceAll(`_`, `/`));
        return parseJsonWith(json, TokenPayloadSchema)?.ro ?? false;
    } catch {
        // allow(silent-catch): a token that is not castd's format is no hint either way; the hello will say.
        return false;
    }
};
