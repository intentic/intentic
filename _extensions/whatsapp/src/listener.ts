import { chatRings, createBufferedPainter, failureNotice, framePainter, type GatewayCtx, type ListenerMessage, recentKeys, typingHeartbeat } from "@intentic/connector-runtime";
import type { WhatsAppConnection } from "./client.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

// Safety ceiling far under WhatsApp's real 65,536-char limit, not a message-splitting boundary.
export const WHATSAPP_MAX = 60_000;

// Normalizes each live message into a dispatch to the daemon; a mention holds a typing indicator until the reply lands
// complete. With no history API, mention context comes from a small per-chat ring of what this process has observed,
// empty after a restart and never including this device's own sends.

// Recent `chat:id` keys, to drop a redelivered message; best-effort, a restart risks one duplicate wake.
const RECENT_MAX = 500;
// Prior messages given to the model per chat when addressed, and how many chats keep a ring.
const HISTORY_LIMIT = 20;
const HISTORY_CHATS_MAX = 200;
// Typing indicator expires ~10s; resent on this interval, capped so a stuck turn can't leak it forever.
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 300_000;

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
}

// Unwraps WhatsApp's protocol envelopes (disappearing chats, view-once, captioned documents) to the real content.
export const unwrap = (content: WaMessageContent | null | undefined): WaMessageContent | undefined => {
    if (content === null || content === undefined) {
        return undefined;
    }
    const inner =
        content.ephemeralMessage?.message ??
        content.viewOnceMessage?.message ??
        content.viewOnceMessageV2?.message ??
        content.documentWithCaptionMessage?.message;
    return inner === undefined ? content : unwrap(inner);
};

// User portion of a JID, with device suffix stripped; the stable identity used to compare mentions and authors.
export const jidUser = (jid: string | null | undefined): string => jid?.split("@")[0]?.split(":")[0]?.split("/")[0] ?? "";

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
    if (content.audioMessage !== undefined) {
        const seconds = content.audioMessage.seconds;
        const kind = content.audioMessage.ptt === true ? "voice note" : "audio";
        return seconds === undefined || seconds === 0 ? `[${kind}]` : `[${kind}, ${seconds}s]`;
    }
    if (content.imageMessage !== undefined) {
        return "[photo]";
    }
    if (content.documentMessage !== undefined) {
        return `[file: ${content.documentMessage.fileName ?? "document"}]`;
    }
    if (content.videoMessage !== undefined) {
        return "[video]";
    }
    if (content.stickerMessage !== undefined) {
        return "[sticker]";
    }
    if (content.locationMessage !== undefined) {
        const name = content.locationMessage.name;
        return name === undefined || name === "" ? "[location]" : `[location: ${name}]`;
    }
    if (content.contactMessage !== undefined) {
        return `[contact: ${content.contactMessage.displayName ?? "card"}]`;
    }
    return "";
};

const mediaCaption = (content: WaMessageContent): string | undefined =>
    content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption;

// Whether the unwrapped content carries a downloadable medium, for `extra.attachments` and `whatsapp download`.
export const hasMedia = (content: WaMessageContent | undefined): boolean =>
    content !== undefined &&
    (content.imageMessage !== undefined ||
        content.videoMessage !== undefined ||
        content.documentMessage !== undefined ||
        content.audioMessage !== undefined ||
        content.stickerMessage !== undefined);

// Whether this message addresses us: always true in a DM, in a group only via an @mention of our identities or a reply
// to our own message.
export const addressesUs = (chat: string, content: WaMessageContent | undefined, selves: ReadonlySet<string>): boolean => {
    if (!chat.endsWith("@g.us")) {
        return true;
    }
    const context =
        content?.extendedTextMessage?.contextInfo ??
        content?.imageMessage?.contextInfo ??
        content?.videoMessage?.contextInfo ??
        content?.documentMessage?.contextInfo ??
        content?.audioMessage?.contextInfo;
    if (context === undefined) {
        return false;
    }
    if ((context.mentionedJid ?? []).some((jid) => selves.has(jidUser(jid)))) {
        return true;
    }
    return context.participant !== undefined && selves.has(jidUser(context.participant));
};

// Raw timestamp is epoch seconds, sometimes delivered as a protobuf Long-like object.
export const timestampOf = (raw: WaRawMessage): string => {
    const value = raw.messageTimestamp;
    const seconds = typeof value === "number" ? value : (value?.toNumber() ?? 0);
    return new Date(seconds * 1_000).toISOString();
};

export interface WhatsAppListener {
    readonly onMessage: (connection: WhatsAppConnection, message: WaRawMessage) => void;
    readonly stopAll: () => void;
}

export const createWhatsAppListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, WhatsAppConnection>): WhatsAppListener => {
    const recent = recentKeys(RECENT_MAX);
    // Stand-in for a history API: what this process has itself watched go by, per chat.
    const seen = chatRings<HistoryEntry>({ perChat: HISTORY_LIMIT, chats: HISTORY_CHATS_MAX });
    // Typing indicators keyed by chat JID; stopping one sends WhatsApp's "paused" presence.
    const typing = typingHeartbeat({ intervalMs: TYPING_INTERVAL_MS, maxMs: TYPING_MAX_MS });

    const startTyping = (connection: WhatsAppConnection, chat: string): void => {
        typing.start(
            chat,
            () => void connection.presence(chat, "composing").catch(() => undefined),
            () => void connection.presence(chat, "paused").catch(() => undefined),
        );
    };

    const onMessage = async (connection: WhatsAppConnection, raw: WaRawMessage): Promise<void> => {
        const chat = raw.key.remoteJid;
        const id = raw.key.id;
        if (chat === undefined || chat === null || id === undefined || id === null) {
            return;
        }
        // Own sends, including from other linked devices, must never trigger a wake.
        if (raw.key.fromMe === true) {
            return;
        }
        const key = `${chat}:${id}`;
        if (recent.duplicate(key)) {
            return;
        }

        const content = unwrap(raw.message);
        const text = contentOf(content);
        const media = hasMedia(content);
        // Bookkeeping events (receipts, edits, key changes) share this stream with real messages; skip them.
        if (text === "" && !media) {
            return;
        }

        const senderJid = chat.endsWith("@g.us") ? (raw.key.participant ?? "") : chat;
        const author = { id: jidUser(senderJid), name: raw.pushName ?? jidUser(senderJid) };
        const timestamp = timestampOf(raw);
        // Stored regardless of whether this message wakes anything; it's context for the next mention.
        const history = seen.of(chat);
        seen.remember(chat, { author, content: text, timestamp });

        const selves = new Set(
            [...connections().values()]
                .flatMap((each) => [each.selfJid(), each.selfLid()])
                .flatMap((jid) => (jid === undefined ? [] : [jidUser(jid)])),
        );
        const mentioned = addressesUs(chat, content, selves);
        const payload: ListenerMessage = {
            provider: "whatsapp",
            type: "message",
            id,
            channelId: chat,
            author,
            content: text,
            ...(mentioned ? { mentioned: true } : {}),
            ...(history.length > 0 ? { history } : {}),
            timestamp,
            extra: {
                chatType: chat.endsWith("@g.us") ? "group" : "dm",
                ...(media ? { attachments: [{ name: text.startsWith("[") ? text.slice(1, -1) : "media", id }] } : {}),
            },
        };

        if (!mentioned) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        // Typing starts immediately on being addressed and holds until the turn's single, complete reply lands.
        startTyping(connection, chat);
        const onError = (error: unknown): void => ctx.log.warn({ err: error }, "whatsapp reply send failed");
        // Quotes the triggering message in a group reply; a DM reply doesn't need to point at anything.
        const send = (body: string): Promise<void> => connection.sendText(chat, body, chat.endsWith("@g.us") ? id : undefined);
        try {
            await ctx.daemon.dispatchStreaming(
                payload,
                framePainter(
                    () => createBufferedPainter(send, onError, WHATSAPP_MAX),
                    // Sent directly, not through the painter: a failed turn usually has no reply text for the painter
                    // to own.
                    (reason) => void send(failureNotice(reason, WHATSAPP_MAX)).catch(onError),
                ),
            );
        } finally {
            typing.stop(chat);
        }
    };

    return {
        onMessage: (connection, raw) => {
            void onMessage(connection, raw).catch((error: unknown) => ctx.log.error({ err: error }, "whatsapp message dispatch failed"));
        },
        stopAll: typing.stopAll,
    };
};
