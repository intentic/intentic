import { createBufferedPainter, failureNotice, framePainter, type GatewayCtx, type ListenerMessage } from "@intentic/connector-runtime";
import type { WhatsAppConnection } from "./client.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

/* WhatsApp's reply is deliberately NOT streamed (createBufferedPainter): the other chat gateways grow a
 * message with edits as the model types, but here a message being rewritten twice a second is exactly the
 * automation fingerprint that gets numbers flagged, and every edit wears a visible "edited" label. The reply
 * buffers and lands once on turn end; the ceiling is a safety net, not a pagination scheme (WhatsApp takes
 * 65,536 chars). */
const WHATSAPP_MAX = 60_000;

/* The inbound half of the gateway: every live message a paired session receives becomes a normalized listener
 * message POSTed to the daemon's dispatch route. On a mention we hold the streaming response, show "typing…"
 * for the length of the turn, and send the reply once it is complete (stream.ts says why it is not painted
 * live here).
 *
 * LIKE TELEGRAM, THERE IS NO HISTORY API — worse, actually: WhatsApp is end-to-end encrypted, so not even
 * WhatsApp could hand us a chat's past. The context the model gets when it is addressed is what THIS PROCESS
 * watched go by, kept in a small per-chat ring. A gateway restart starts the ring empty, and our own replies
 * are not in it (a linked device does not receive its own sends as live traffic) — they do not need to be,
 * because a chat is one continuing conversation (thread-sessions) and the agent remembers what it said. */

// Recent `chat:id` keys, to drop a redelivered message. ponytail: best-effort in-memory cap; a restart forgets
// it — at worst one duplicate wake.
const RECENT_MAX = 500;
// Prior messages handed to the model when the bot is addressed, per chat, and how many chats we keep rings for.
const HISTORY_LIMIT = 20;
const HISTORY_CHATS_MAX = 200;
// WhatsApp's "typing…" presence expires after ~10s; re-send on this cadence so it shows for the whole turn.
// Capped so a turn that never replies can't leak the interval forever.
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 300_000;

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
}

// The real content, out of WhatsApp's protocol envelopes (disappearing chats, view-once, captioned documents).
// Exported for tests.
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

// The user half of a JID ("4915112345678@s.whatsapp.net" → "4915112345678", device suffixes stripped): the
// stable identity mentions and reply-authors are compared by, whatever domain or device they arrived with.
export const jidUser = (jid: string | null | undefined): string => jid?.split("@")[0]?.split(":")[0]?.split("/")[0] ?? "";

/* What the message says, when it carries no words. A voice note or a photo without a caption reaches the model
 * as an empty string otherwise, which reads as "someone sent nothing" — the medium itself is in
 * `extra.attachments` for an agent that wants to fetch it. Exported for tests. */
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

// Whether the (unwrapped) content carries a downloadable medium — what puts the message id into
// `extra.attachments` for `whatsapp download`.
export const hasMedia = (content: WaMessageContent | undefined): boolean =>
    content !== undefined &&
    (content.imageMessage !== undefined ||
        content.videoMessage !== undefined ||
        content.documentMessage !== undefined ||
        content.audioMessage !== undefined ||
        content.stickerMessage !== undefined);

// Does this message address us? A DM always does; in a group it is an @mention of any of our identities
// (phone JID or hidden-number @lid) or a reply to something we sent. Exported for tests.
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

// A raw timestamp is seconds since epoch, sometimes as a protobuf Long-like object.
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
    const recent = new Set<string>();
    // The stand-in for a history API: what this process has watched go by, per chat, oldest first. Insertion
    // order is recency (a push re-inserts its chat), so evicting the first key drops the chat quiet longest.
    const seen = new Map<string, HistoryEntry[]>();
    // Live "typing…" indicators keyed by chat JID.
    const typing = new Map<string, NodeJS.Timeout>();

    const remember = (chat: string, entry: HistoryEntry): void => {
        const ring = seen.get(chat) ?? [];
        ring.push(entry);
        seen.delete(chat);
        seen.set(chat, ring.slice(-HISTORY_LIMIT));
        if (seen.size > HISTORY_CHATS_MAX) {
            const quietest = seen.keys().next().value;
            if (quietest !== undefined) {
                seen.delete(quietest);
            }
        }
    };

    const stopTyping = (connection: WhatsAppConnection, chat: string): void => {
        const timer = typing.get(chat);
        if (timer !== undefined) {
            clearInterval(timer);
            typing.delete(chat);
            void connection.presence(chat, "paused").catch(() => undefined);
        }
    };

    const startTyping = (connection: WhatsAppConnection, chat: string): void => {
        const send = (): void => void connection.presence(chat, "composing").catch(() => undefined);
        const timer = typing.get(chat);
        if (timer !== undefined) {
            clearInterval(timer);
        }
        send();
        const startedAt = Date.now();
        typing.set(
            chat,
            setInterval(() => {
                if (Date.now() - startedAt > TYPING_MAX_MS) {
                    stopTyping(connection, chat);
                    return;
                }
                send();
            }, TYPING_INTERVAL_MS),
        );
    };

    const onMessage = async (connection: WhatsAppConnection, raw: WaRawMessage): Promise<void> => {
        const chat = raw.key.remoteJid;
        const id = raw.key.id;
        if (chat === undefined || chat === null || id === undefined || id === null) {
            return;
        }
        // Our own sends and our own linked devices' sends must never wake us.
        if (raw.key.fromMe === true) {
            return;
        }
        const key = `${chat}:${id}`;
        if (recent.has(key)) {
            return;
        }
        recent.add(key);
        if (recent.size > RECENT_MAX) {
            const oldest = recent.values().next().value;
            if (oldest !== undefined) {
                recent.delete(oldest);
            }
        }

        const content = unwrap(raw.message);
        const text = contentOf(content);
        const media = hasMedia(content);
        // Receipts, edits, reaction notices, key changes — bookkeeping arrives on the same stream as speech,
        // and only speech (or something fetchable) is worth an agent's attention.
        if (text === "" && !media) {
            return;
        }

        const senderJid = chat.endsWith("@g.us") ? (raw.key.participant ?? "") : chat;
        const author = { id: jidUser(senderJid), name: raw.pushName ?? jidUser(senderJid) };
        const timestamp = timestampOf(raw);
        // The ring is context for the NEXT mention, so this message goes in whether or not it wakes anything.
        const history = [...(seen.get(chat) ?? [])];
        remember(chat, { author, content: text, timestamp });

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
        // Immediate feedback: "typing…" the moment we're addressed, held for the whole (debounced) turn. The
        // reply itself lands once, complete, when the turn ends — see stream.ts for why.
        startTyping(connection, chat);
        const onError = (error: unknown): void => ctx.log.warn({ err: error }, "whatsapp reply send failed");
        // In a group the answer points at what it answers; in a DM that is just noise.
        const send = (body: string): Promise<void> => connection.sendText(chat, body, chat.endsWith("@g.us") ? id : undefined);
        try {
            await ctx.daemon.dispatchStreaming(
                payload,
                framePainter(
                    () => createBufferedPainter(send, onError, WHATSAPP_MAX),
                    // Its own message rather than through the painter: the painter owns the reply text, and a
                    // turn that failed usually has none to send.
                    (reason) => void send(failureNotice(reason, WHATSAPP_MAX)).catch(onError),
                ),
            );
        } finally {
            stopTyping(connection, chat);
        }
    };

    return {
        onMessage: (connection, raw) => {
            void onMessage(connection, raw).catch((error: unknown) => ctx.log.error({ err: error }, "whatsapp message dispatch failed"));
        },
        stopAll: () => {
            for (const timer of typing.values()) {
                clearInterval(timer);
            }
            typing.clear();
        },
    };
};
