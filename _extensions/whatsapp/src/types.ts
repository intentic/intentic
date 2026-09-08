// Structural slice of a WhatsApp message, not baileys' generated proto types; shared by client.ts (casts protos to it)
// and listener.ts (normalizes it). Import-free so it stays testable without baileys installed.

export interface WaContextInfo {
    // JIDs this message @mentions; in groups these may be @lid identities, not phone JIDs.
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
    // Envelope kinds: content sits one level down; protocolMessage and reactionMessage carry none.
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
