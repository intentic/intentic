/* The slice of a WhatsApp message this extension reads, structurally — NOT baileys' generated proto types.
 * Shared by client.ts (which casts real protos to it at the boundary) and listener.ts (which normalizes it),
 * and deliberately import-free: everything except client.ts stays testable without baileys installed, because
 * the sandbox installs a new package's dependencies only after the turn that adds them.
 *
 * WhatsApp wraps a message's real content in protocol envelopes (disappearing chats, view-once) and splits the
 * "what was written" across per-kind fields — unwrapping and reading those is listener.ts's job; this file just
 * names the fields it does that with. */

export interface WaContextInfo {
    // JIDs this message @mentions. In groups these may be @lid (hidden-number) identities, not phone JIDs.
    readonly mentionedJid?: readonly string[];
    // The author of the message this one replies to.
    readonly participant?: string;
}

export interface WaMessageContent {
    readonly conversation?: string;
    readonly extendedTextMessage?: { readonly text?: string; readonly contextInfo?: WaContextInfo };
    readonly imageMessage?: { readonly caption?: string; readonly mimetype?: string; readonly contextInfo?: WaContextInfo };
    readonly videoMessage?: { readonly caption?: string; readonly mimetype?: string; readonly contextInfo?: WaContextInfo };
    readonly documentMessage?: {
        readonly fileName?: string;
        readonly caption?: string;
        readonly mimetype?: string;
        readonly contextInfo?: WaContextInfo;
    };
    readonly audioMessage?: { readonly seconds?: number; readonly ptt?: boolean; readonly mimetype?: string; readonly contextInfo?: WaContextInfo };
    readonly stickerMessage?: { readonly mimetype?: string };
    readonly locationMessage?: { readonly degreesLatitude?: number; readonly degreesLongitude?: number; readonly name?: string };
    readonly contactMessage?: { readonly displayName?: string };
    // Envelope kinds: the real content sits one level down (or, for protocolMessage, there is none — edits,
    // deletes and sync notices are bookkeeping, not messages).
    readonly ephemeralMessage?: { readonly message?: WaMessageContent };
    readonly viewOnceMessage?: { readonly message?: WaMessageContent };
    readonly viewOnceMessageV2?: { readonly message?: WaMessageContent };
    readonly documentWithCaptionMessage?: { readonly message?: WaMessageContent };
    readonly protocolMessage?: object;
    readonly reactionMessage?: object;
}

export interface WaRawMessage {
    readonly key: {
        readonly id?: string | null;
        // The chat: <user>@s.whatsapp.net for a DM, <id>@g.us for a group, status@broadcast for stories.
        readonly remoteJid?: string | null;
        readonly fromMe?: boolean | null;
        // In a group, the actual sender (remoteJid is the group).
        readonly participant?: string | null;
    };
    readonly pushName?: string | null;
    // Seconds since epoch; baileys may hand it over as a Long-like object, so it is read through Number().
    readonly messageTimestamp?: number | { toNumber: () => number } | null;
    readonly message?: WaMessageContent | null;
}
