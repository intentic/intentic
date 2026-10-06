import {
    type GatewayCtx,
    HISTORY_LIMIT,
    type ListenerHistoryEntry,
    type ListenerMessage,
    MESSAGE_LIMITS,
    paintReply,
    recentKeys,
    typingHeartbeat,
} from "@intentic/connector-runtime";
import type { WhatsAppConnection } from "./client.js";
import { contentOf, contextOf, hasMedia, isGroupJid, jidUser, type QuotedRef, quotedOf, timestampOf, unwrap } from "./content.js";
import type { MessageRow } from "./store.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

// WhatsApp's one-message ceiling; a reply that long is rare enough that this is a safety net, not pagination.
export const WHATSAPP_MAX = MESSAGE_LIMITS.whatsapp;

// Normalizes each live message into a dispatch to the daemon; a mention holds a typing indicator until the reply lands
// complete. Context comes from the session's store: what WhatsApp synced at pairing, what the phone sent on request,
// and everything since, our own replies included. Authors are named by phone number whenever WhatsApp let us learn
// it, since an automation's sender rules are written in phone numbers.

// Typing indicator expires ~10s; resent on this interval.
const TYPING_INTERVAL_MS = 8_000;

// Whether this message addresses us: always true in a DM, in a group only via an @mention of our identities or a reply
// to our own message.
export const addressesUs = (chat: string, content: WaMessageContent | undefined, selves: ReadonlySet<string>): boolean => {
    if (!isGroupJid(chat)) {
        return true;
    }
    const context = contextOf(content);
    if (context === undefined || context === null) {
        return false;
    }
    if ((context.mentionedJid ?? []).some((jid) => selves.has(jidUser(jid)))) {
        return true;
    }
    return context.participant !== undefined && context.participant !== null && selves.has(jidUser(context.participant));
};

export interface WhatsAppListener {
    readonly onMessage: (connection: WhatsAppConnection, message: WaRawMessage) => void;
    readonly stopAll: () => void;
}

// A live message worth telling an agent about: someone else's words or media, not a reaction or bookkeeping.
interface Admitted {
    readonly chat: string;
    readonly id: string;
    readonly content: WaMessageContent | undefined;
    readonly text: string;
    readonly media: boolean;
}

const admit = (raw: WaRawMessage): Admitted | undefined => {
    const { remoteJid: chat, id, fromMe } = raw.key;
    // Own sends, including from other linked devices, must never trigger a wake.
    if (chat === undefined || chat === null || id === undefined || id === null || fromMe === true) {
        return undefined;
    }
    const content = unwrap(raw.message);
    // An emoji on a message is kept in the chat's history, not treated as something said to us.
    if (content?.reactionMessage !== undefined && content.reactionMessage !== null) {
        return undefined;
    }
    const text = contentOf(content);
    const media = hasMedia(content);
    // Bookkeeping events (receipts, edits, key changes) share this stream with real messages; skip them.
    return text === "" && !media ? undefined : { chat, id, content, text, media };
};

// What a reply points back at, its author named the way the agent knows them.
interface ReplyTo {
    id: string;
    text: string;
    author?: string;
}

const replyToOf = (connection: WhatsAppConnection, quoted: QuotedRef, selves: ReadonlySet<string>): ReplyTo => {
    const reply: ReplyTo = { id: quoted.id, text: quoted.text };
    if (quoted.author !== undefined) {
        reply.author = selves.has(jidUser(quoted.author)) ? "you" : (connection.nameOf(quoted.author) ?? jidUser(quoted.author));
    }
    return reply;
};

type Extra = NonNullable<ListenerMessage["extra"]>;

const extraOf = (connection: WhatsAppConnection, message: Admitted, selves: ReadonlySet<string>): Extra => {
    const group = isGroupJid(message.chat);
    const extra: Extra = { chatType: group ? "group" : "dm" };
    const chatName = group ? connection.nameOf(message.chat) : undefined;
    if (chatName !== undefined) {
        extra["chatName"] = chatName;
    }
    const quoted = quotedOf(message.content);
    if (quoted !== undefined) {
        extra["replyTo"] = replyToOf(connection, quoted, selves);
    }
    if (message.media) {
        extra["attachments"] = [{ name: message.text.startsWith("[") ? message.text.slice(1, -1) : "media", id: message.id }];
    }
    return extra;
};

// A stored message as one line of the history a mention carries.
const historyEntry = (connection: WhatsAppConnection, row: MessageRow): ListenerHistoryEntry => {
    const timestamp = new Date(row.ts * 1_000).toISOString();
    if (row.fromMe) {
        return { author: { id: jidUser(connection.selfJid()), name: "you" }, content: row.text, timestamp, self: true };
    }
    const id = jidUser(row.author);
    const name = (row.author === undefined ? undefined : connection.nameOf(row.author)) ?? row.authorName ?? id;
    return { author: { id, name }, content: row.text, timestamp };
};

// The dispatch for an admitted message. `author.id` is what sender rules match, and the automation card asks for a
// phone number: the @lid stands in only when WhatsApp never let us learn the number.
const payloadOf = async (connection: WhatsAppConnection, raw: WaRawMessage, message: Admitted, selves: ReadonlySet<string>): Promise<ListenerMessage> => {
    const sender = await connection.sender(raw);
    const authorId = jidUser(sender.phone ?? sender.lid) || jidUser(isGroupJid(message.chat) ? raw.key.participant : message.chat);
    const payload: ListenerMessage = {
        provider: "whatsapp",
        type: "message",
        id: message.id,
        channelId: message.chat,
        author: { id: authorId, name: sender.name ?? authorId },
        content: message.text,
        timestamp: timestampOf(raw),
        extra: extraOf(connection, message, selves),
    };
    if (addressesUs(message.chat, message.content, selves)) {
        payload.mentioned = true;
    }
    const history = connection.recent(message.chat, HISTORY_LIMIT, message.id).map((row) => historyEntry(connection, row));
    if (history.length > 0) {
        payload.history = history;
    }
    return payload;
};

export const createWhatsAppListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, WhatsAppConnection>): WhatsAppListener => {
    const recent = recentKeys();
    // Typing indicators keyed by chat JID; stopping one sends WhatsApp's "paused" presence.
    const typing = typingHeartbeat({ intervalMs: TYPING_INTERVAL_MS });

    const startTyping = (connection: WhatsAppConnection, chat: string): void => {
        typing.start(
            chat,
            () => void connection.presence(chat, "composing").catch(() => undefined),
            () => void connection.presence(chat, "paused").catch(() => undefined),
        );
    };

    const onMessage = async (connection: WhatsAppConnection, raw: WaRawMessage): Promise<void> => {
        const message = admit(raw);
        if (message === undefined || recent.duplicate(`${message.chat}:${message.id}`)) {
            return;
        }
        const selves = new Set(
            [...connections().values()]
                .flatMap((each) => [each.selfJid(), each.selfLid()])
                .flatMap((jid) => (jid === undefined ? [] : [jidUser(jid)])),
        );
        const payload = await payloadOf(connection, raw, message, selves);
        if (payload.mentioned !== true) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        const { chat, id } = message;
        // Typing starts immediately on being addressed and holds until the turn's single, complete reply lands.
        startTyping(connection, chat);
        await paintReply(ctx.daemon, payload, {
            // Quotes the triggering message in a group reply; a DM reply doesn't need to point at anything.
            surface: { send: (body: string) => connection.sendText(chat, body, isGroupJid(chat) ? id : undefined) },
            maxChars: WHATSAPP_MAX,
            onError: (error) => ctx.log.warn({ err: error }, "whatsapp reply send failed"),
            settle: () => typing.stop(chat),
        });
    };

    return {
        onMessage: (connection, raw) => {
            void onMessage(connection, raw).catch((error: unknown) => ctx.log.error({ err: error }, "whatsapp message dispatch failed"));
        },
        stopAll: typing.stopAll,
    };
};
