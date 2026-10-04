// Structural slice of a WhatsApp message, not baileys' generated proto types; shared by client.ts (casts protos to it)
// and listener.ts (normalizes it). Import-free so it stays testable without baileys installed.

export interface WaContextInfo {
    // JIDs this message @mentions; in groups these may be @lid identities, not phone JIDs.
    readonly mentionedJid?: readonly string[] | null;
    // The author of the message this one replies to.
    readonly participant?: string | null;
    // The id of the message this one replies to, and that message's content as the sender's phone quoted it.
    readonly stanzaId?: string | null;
    readonly quotedMessage?: WaMessageContent | null;
}

export interface WaMessageKeyRef {
    readonly id?: string | null;
    readonly remoteJid?: string | null;
    readonly fromMe?: boolean | null;
    readonly participant?: string | null;
}

export interface WaMessageContent {
    readonly conversation?: string | null;
    readonly extendedTextMessage?: { readonly text?: string | null; readonly contextInfo?: WaContextInfo | null } | null;
    readonly imageMessage?: { readonly caption?: string | null; readonly mimetype?: string | null; readonly contextInfo?: WaContextInfo | null } | null;
    readonly videoMessage?: { readonly caption?: string | null; readonly mimetype?: string | null; readonly contextInfo?: WaContextInfo | null } | null;
    readonly documentMessage?: {
        readonly fileName?: string | null;
        readonly caption?: string | null;
        readonly mimetype?: string | null;
        readonly contextInfo?: WaContextInfo | null;
    } | null;
    readonly audioMessage?: {
        readonly seconds?: number | null;
        readonly ptt?: boolean | null;
        readonly mimetype?: string | null;
        readonly contextInfo?: WaContextInfo | null;
    } | null;
    readonly stickerMessage?: { readonly mimetype?: string | null; readonly contextInfo?: WaContextInfo | null } | null;
    readonly locationMessage?: { readonly degreesLatitude?: number | null; readonly degreesLongitude?: number | null; readonly name?: string | null } | null;
    readonly contactMessage?: { readonly displayName?: string | null } | null;
    // Envelope kinds: content sits one level down.
    readonly ephemeralMessage?: { readonly message?: WaMessageContent | null } | null;
    readonly viewOnceMessage?: { readonly message?: WaMessageContent | null } | null;
    readonly viewOnceMessageV2?: { readonly message?: WaMessageContent | null } | null;
    readonly documentWithCaptionMessage?: { readonly message?: WaMessageContent | null } | null;
    readonly editedMessage?: { readonly message?: WaMessageContent | null } | null;
    // Bookkeeping kinds: an edit or a delete of an earlier message (type 14 / 0), and an emoji on one ("" removes it).
    readonly protocolMessage?: {
        readonly type?: number | null;
        readonly key?: WaMessageKeyRef | null;
        readonly editedMessage?: WaMessageContent | null;
    } | null;
    readonly reactionMessage?: { readonly key?: WaMessageKeyRef | null; readonly text?: string | null } | null;
}

export interface WaRawMessage {
    readonly key: {
        readonly id?: string | null;
        // The chat: <user>@s.whatsapp.net or <lid>@lid for a DM, <id>@g.us for a group, status@broadcast for stories.
        readonly remoteJid?: string | null;
        // The other form of a DM's address: the phone JID when remoteJid is a @lid, the @lid when it is a phone.
        readonly remoteJidAlt?: string | null;
        readonly fromMe?: boolean | null;
        // In a group, the actual sender (remoteJid is the group), and the other form of that sender's address.
        readonly participant?: string | null;
        readonly participantAlt?: string | null;
    };
    readonly pushName?: string | null;
    // Seconds since epoch; baileys may hand it over as a Long-like object, so it is read through Number().
    readonly messageTimestamp?: number | { toNumber: () => number } | null;
    readonly message?: WaMessageContent | null;
}
