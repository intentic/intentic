import type { WaContextInfo, WaMessageContent, WaRawMessage } from "./types.js";

// Reading a WhatsApp message without baileys: envelopes, the words in it, who it quotes, and the JID shapes WhatsApp
// addresses people by. Shared by the listener (what wakes an agent) and the store (what the CLI reads back).

// A protocol message that replaced an earlier message's text, and one that deleted it for everyone.
export const PROTOCOL_EDIT = 14;
export const PROTOCOL_REVOKE = 0;

// Unwraps WhatsApp's protocol envelopes (disappearing chats, view-once, captioned documents, edits) to the real content.
export const unwrap = (content: WaMessageContent | null | undefined): WaMessageContent | undefined => {
    if (content === null || content === undefined) {
        return undefined;
    }
    const inner =
        content.ephemeralMessage?.message ??
        content.viewOnceMessage?.message ??
        content.viewOnceMessageV2?.message ??
        content.documentWithCaptionMessage?.message ??
        content.editedMessage?.message;
    return inner === undefined || inner === null ? content : unwrap(inner);
};

// User portion of a JID, with device suffix stripped; the stable identity used to compare mentions and authors.
export const jidUser = (jid: string | null | undefined): string => jid?.split("@")[0]?.split(":")[0]?.split("/")[0] ?? "";

// A JID without its device suffix: "4915…:12@s.whatsapp.net" and "4915…@s.whatsapp.net" are the same person.
export const bareJid = (jid: string): string => {
    const at = jid.indexOf("@");
    return at === -1 ? jid : `${jidUser(jid)}${jid.slice(at)}`;
};

export const isGroupJid = (jid: string | null | undefined): boolean => jid?.endsWith("@g.us") === true;
export const isLidJid = (jid: string | null | undefined): boolean => jid?.endsWith("@lid") === true;
export const isPhoneJid = (jid: string | null | undefined): boolean => jid?.endsWith("@s.whatsapp.net") === true;

// Digits-only input becomes a phone JID; people write numbers with +, spaces and dashes.
export const phoneJidOf = (number: string): string => `${number.replaceAll(/\D/g, "")}@s.whatsapp.net`;

// Whether free text is meant as a phone number rather than a name: digits and the punctuation people put between them.
export const looksLikePhone = (text: string): boolean => /^\+?[\d\s().-]{6,}$/.test(text.trim()) && text.replaceAll(/\D/g, "").length >= 6;

const mediaCaption = (content: WaMessageContent): string | undefined =>
    content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption ?? undefined;

// Text summary for a message with no words (a voice note, an uncaptioned photo), so it doesn't read as empty; the
// medium itself travels via `extra.attachments`.
export const contentOf = (content: WaMessageContent | undefined): string => {
    if (content === undefined) {
        return "";
    }
    const written = content.conversation ?? content.extendedTextMessage?.text ?? mediaCaption(content) ?? "";
    if (written !== "") {
        return written;
    }
    if (content.audioMessage !== undefined && content.audioMessage !== null) {
        const seconds = content.audioMessage.seconds;
        const kind = content.audioMessage.ptt === true ? "voice note" : "audio";
        return seconds === undefined || seconds === null || seconds === 0 ? `[${kind}]` : `[${kind}, ${seconds}s]`;
    }
    if (content.imageMessage !== undefined && content.imageMessage !== null) {
        return "[photo]";
    }
    if (content.documentMessage !== undefined && content.documentMessage !== null) {
        return `[file: ${content.documentMessage.fileName ?? "document"}]`;
    }
    if (content.videoMessage !== undefined && content.videoMessage !== null) {
        return "[video]";
    }
    if (content.stickerMessage !== undefined && content.stickerMessage !== null) {
        return "[sticker]";
    }
    if (content.locationMessage !== undefined && content.locationMessage !== null) {
        const name = content.locationMessage.name;
        return name === undefined || name === null || name === "" ? "[location]" : `[location: ${name}]`;
    }
    if (content.contactMessage !== undefined && content.contactMessage !== null) {
        return `[contact: ${content.contactMessage.displayName ?? "card"}]`;
    }
    return "";
};

// Whether the unwrapped content carries a downloadable medium, for `extra.attachments` and `whatsapp download`.
export const hasMedia = (content: WaMessageContent | undefined): boolean =>
    content !== undefined &&
    [content.imageMessage, content.videoMessage, content.documentMessage, content.audioMessage, content.stickerMessage].some(
        (slot) => slot !== undefined && slot !== null,
    );

// The reply/mention context, wherever this kind of message keeps it.
export const contextOf = (content: WaMessageContent | undefined): WaContextInfo | undefined =>
    content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.documentMessage?.contextInfo ??
    content?.audioMessage?.contextInfo ??
    content?.stickerMessage?.contextInfo ??
    undefined;

export interface QuotedRef {
    readonly id: string;
    // Raw JID of the quoted message's author, as WhatsApp sent it (phone or @lid).
    readonly author?: string;
    readonly text: string;
}

// What this message replies to, when it is a reply: the quoted message's id, author and words.
export const quotedOf = (content: WaMessageContent | undefined): QuotedRef | undefined => {
    const context = contextOf(content);
    const id = context?.stanzaId;
    if (id === undefined || id === null || id === "") {
        return undefined;
    }
    const author = context?.participant ?? undefined;
    return { id, ...(author === undefined || author === "" ? {} : { author }), text: contentOf(unwrap(context?.quotedMessage)) };
};

// Raw timestamp is epoch seconds, sometimes a protobuf Long (history sync), or its bare {low, high} once through JSON.
export const secondsOf = (raw: WaRawMessage): number => toSeconds(raw.messageTimestamp);

export const toSeconds = (value: unknown): number => {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "object" && value !== null) {
        if ("toNumber" in value && typeof value.toNumber === "function") {
            return Number(value.toNumber());
        }
        if ("low" in value && typeof value.low === "number") {
            return (value.low >>> 0) + ("high" in value && typeof value.high === "number" ? value.high * 2 ** 32 : 0);
        }
    }
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

export const timestampOf = (raw: WaRawMessage): string => new Date(secondsOf(raw) * 1_000).toISOString();
