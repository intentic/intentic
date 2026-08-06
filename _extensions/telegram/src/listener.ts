import { type TelegramConnection, TelegramApiError, type TelegramMessage, type TelegramUpdate } from "./client.js";
import type { GatewayCtx } from "./context.js";
import { createTelegramStream, type Painter, type TelegramPoster } from "./stream.js";

/* The inbound half of the gateway: every update a connected bot long-polls becomes a normalized listener
 * message POSTed to the daemon's dispatch route. On a mention we hold the streaming response and paint the
 * model's reply into the chat live (one painter per matched automation, keyed by automationId), with Telegram's
 * "typing…" action as the "I'm on it" signal — the same job ext-slack's :eyes: reaction does, in the gesture
 * Telegram actually has.
 *
 * THE ONE THING TELEGRAM DOES NOT GIVE US is history. A bot cannot read a chat's past messages — there is no
 * conversations.history to call — so the context the model gets when it is tagged is what THIS PROCESS watched
 * go by, kept in a small per-chat ring below. That has two consequences worth knowing: a gateway restart starts
 * the ring empty, and in a group with privacy mode ON the ring only ever holds the messages that mentioned the
 * bot. Our own replies are not in it either — bots do not receive their own messages — but they do not need to
 * be: a chat is one continuing conversation (thread-sessions), so the agent already remembers what it said. */

// Recent `chat:message` keys, to drop the duplicate delivery when two of our bots are in one group and both
// receive the same human message. ponytail: best-effort in-memory cap; a restart forgets it — at worst one
// duplicate wake.
const RECENT_MAX = 500;
// Prior messages handed to the model when the bot is tagged, per chat, and how many chats we keep rings for.
const HISTORY_LIMIT = 20;
const HISTORY_CHATS_MAX = 200;
// Telegram's typing action expires after ~5s; re-send on this cadence so the bot shows "typing…" for the whole
// turn. Capped so a turn that never replies can't leak the interval forever.
const TYPING_INTERVAL_MS = 4_000;
const TYPING_MAX_MS = 300_000;
// A 429 during a paint is Telegram asking us to slow down, not to stop — the reply is worth one patient retry.
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

interface HistoryEntry {
    author: { id: string; name: string };
    content: string;
    timestamp: string;
}

// Whatever Telegram lets us call the author. `username` is the stable handle, the names are what people
// actually read; an anonymous channel post has neither, and "channel" beats an empty string.
export const authorNameOf = (message: TelegramMessage): string => {
    const from = message.from;
    if (from === undefined) {
        return message.chat.title ?? "channel";
    }
    const full = [from.first_name, from.last_name].filter((part) => part !== undefined && part !== "").join(" ");
    return full !== "" ? full : (from.username ?? String(from.id));
};

/* What the message is, when it carries no words. A voice note or a photo with no caption reaches the model as
 * an empty string otherwise, which reads as "someone sent nothing" rather than "someone sent a photo" — and the
 * file itself is in `extra.attachments` for an agent that wants to fetch it. Exported for tests. */
export const contentOf = (message: TelegramMessage): string => {
    const written = message.text ?? message.caption ?? "";
    if (written !== "") {
        return written;
    }
    if (message.voice !== undefined) {
        const duration = message.voice.duration;
        return duration === undefined ? "[voice note]" : `[voice note, ${duration}s]`;
    }
    if (message.photo !== undefined) {
        return "[photo]";
    }
    if (message.document !== undefined) {
        return `[file: ${message.document.file_name ?? "document"}]`;
    }
    if (message.video !== undefined) {
        return "[video]";
    }
    if (message.audio !== undefined) {
        return `[audio: ${message.audio.file_name ?? "track"}]`;
    }
    return "";
};

// Every file the message carries, as name + file_id — the id is what `getFile` takes, so this is enough for an
// agent to download one. Exported for tests.
export const attachmentsOf = (message: TelegramMessage): ReadonlyArray<{ name: string; fileId: string }> => {
    const largest = message.photo?.toSorted((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1);
    return [
        ...(largest === undefined ? [] : [{ name: "photo", fileId: largest.file_id }]),
        ...(message.document === undefined ? [] : [{ name: message.document.file_name ?? "document", fileId: message.document.file_id }]),
        ...(message.voice === undefined ? [] : [{ name: "voice", fileId: message.voice.file_id }]),
        ...(message.audio === undefined ? [] : [{ name: message.audio.file_name ?? "audio", fileId: message.audio.file_id }]),
        ...(message.video === undefined ? [] : [{ name: message.video.file_name ?? "video", fileId: message.video.file_id }]),
    ];
};

// Does this message address one of our bots? A `@thebot` anywhere in the text or caption (Telegram lowercases
// nothing, and `/deploy@thebot` is the command form of the same thing), or a reply to something a bot of ours
// posted. A private chat is handled by the caller — there, every message is addressed to us. Exported for tests.
export const addressesUs = (message: TelegramMessage, usernames: ReadonlySet<string>, selfIds: ReadonlySet<number>): boolean => {
    const written = `${message.text ?? ""} ${message.caption ?? ""}`.toLowerCase();
    if ([...usernames].some((username) => written.includes(`@${username.toLowerCase()}`))) {
        return true;
    }
    const repliedTo = message.reply_to_message?.from;
    return repliedTo !== undefined && selfIds.has(repliedTo.id);
};

export interface TelegramListener {
    readonly onUpdate: (connection: TelegramConnection, update: TelegramUpdate) => void;
    readonly stopAll: () => void;
}

export const createTelegramListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, TelegramConnection>): TelegramListener => {
    const recent = new Set<string>();
    // The stand-in for a history API: what this process has watched go by, per chat, oldest first. Insertion
    // order is recency (a push re-inserts its chat), so evicting the first key drops the chat quiet longest.
    const seen = new Map<string, HistoryEntry[]>();
    // Live "typing…" indicators keyed by chatId — started on a mention, cleared when the turn ends or after
    // TYPING_MAX_MS.
    const typing = new Map<string, NodeJS.Timeout>();

    const remember = (chatId: string, entry: HistoryEntry): void => {
        const ring = seen.get(chatId) ?? [];
        ring.push(entry);
        seen.delete(chatId);
        seen.set(chatId, ring.slice(-HISTORY_LIMIT));
        if (seen.size > HISTORY_CHATS_MAX) {
            const quietest = seen.keys().next().value;
            if (quietest !== undefined) {
                seen.delete(quietest);
            }
        }
    };

    const stopTyping = (chatId: string): void => {
        const timer = typing.get(chatId);
        if (timer !== undefined) {
            clearInterval(timer);
            typing.delete(chatId);
        }
    };

    const startTyping = (connection: TelegramConnection, message: TelegramMessage): void => {
        const chatId = String(message.chat.id);
        const action = {
            chat_id: message.chat.id,
            action: "typing",
            ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
        };
        const send = (): void => void connection.call("sendChatAction", action).catch(() => undefined);
        stopTyping(chatId);
        send();
        const startedAt = Date.now();
        typing.set(
            chatId,
            setInterval(() => {
                if (Date.now() - startedAt > TYPING_MAX_MS) {
                    stopTyping(chatId);
                    return;
                }
                send();
            }, TYPING_INTERVAL_MS),
        );
    };

    /* The two Bot API calls the painter makes, with the two failures that are not failures folded in: an edit
     * whose text is unchanged is a no-op Telegram reports as a 400, and a 429 is a request to wait, which we do
     * once (Telegram tells us how long) before giving up on the paint. Everything else reaches the painter,
     * which kills the stream rather than scribbling half a reply. */
    const posterFor = (connection: TelegramConnection, message: TelegramMessage): TelegramPoster => {
        const base = {
            chat_id: message.chat.id,
            ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
            // In a group the answer has to point at what it answers; in a one-to-one chat that is just noise.
            ...(message.chat.type === "private" ? {} : { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } }),
        };
        const patient = async <T>(call: () => Promise<T>): Promise<T> => {
            try {
                return await call();
            } catch (error) {
                const wait = rateLimitWaitOf(error);
                if (wait === undefined) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, wait));
                return await call();
            }
        };
        return {
            post: async (text) => {
                const posted = await patient(() => connection.call<{ message_id: number }>("sendMessage", { ...base, text }));
                return posted.message_id;
            },
            update: async (messageId, text) => {
                await patient(() => connection.call("editMessageText", { chat_id: message.chat.id, message_id: messageId, text })).catch(
                    (error: unknown) => {
                        if (!isUnchangedEdit(error)) {
                            throw error;
                        }
                    },
                );
            },
        };
    };

    const onMessage = async (connection: TelegramConnection, message: TelegramMessage): Promise<void> => {
        const chatId = String(message.chat.id);
        const key = `${chatId}:${message.message_id}`;
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
        const live = [...connections().values()];
        const selfIds = new Set(live.map((each) => each.selfId));
        // Telegram never delivers one bot's messages to another, so this is insurance rather than a filter —
        // but an agent woken by its own reply is the failure it insures against.
        if (message.from !== undefined && selfIds.has(message.from.id)) {
            return;
        }

        const content = contentOf(message);
        const timestamp = new Date(message.date * 1_000).toISOString();
        const author = { id: String(message.from?.id ?? message.chat.id), name: authorNameOf(message) };
        // The ring is context for the NEXT mention, so this message goes in whether or not it wakes anything —
        // that is the whole point of keeping one.
        const history = [...(seen.get(chatId) ?? [])];
        remember(chatId, { author, content, timestamp });

        const usernames = new Set(live.map((each) => each.username));
        const mentioned = message.chat.type === "private" || addressesUs(message, usernames, selfIds);
        const attachments = attachmentsOf(message);
        const payload = {
            provider: "telegram",
            type: "message",
            id: String(message.message_id),
            channelId: chatId,
            author,
            content,
            ...(mentioned ? { mentioned: true } : {}),
            ...(history.length > 0 ? { history } : {}),
            timestamp,
            extra: {
                chatType: message.chat.type,
                messageId: message.message_id,
                ...(message.chat.title === undefined ? {} : { chatTitle: message.chat.title }),
                ...(message.message_thread_id === undefined ? {} : { messageThreadId: message.message_thread_id }),
                ...(attachments.length > 0 ? { attachments } : {}),
            },
        };

        if (!mentioned) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        // Immediate feedback: show "typing…" the moment we're tagged, before the (debounced) turn spins up.
        startTyping(connection, message);
        // Paint the reply into the chat live. Each matched automation gets its own painter, so two automations
        // answering one mention don't scribble over each other's message.
        const poster = posterFor(connection, message);
        const painters = new Map<string, Painter>();
        const onError = (error: unknown): void => ctx.log.warn({ err: error }, "telegram stream paint failed");
        try {
            await ctx.daemon.dispatchStreaming(payload, (frame) => {
                let painter = painters.get(frame.automationId);
                if (painter === undefined) {
                    painter = createTelegramStream(poster, onError);
                    painters.set(frame.automationId, painter);
                }
                if (frame.delta !== undefined) {
                    painter.delta(frame.delta);
                }
                if (frame.end === true) {
                    painter.end();
                }
            });
        } finally {
            // The turn(s) ended (or the stream broke) — the reply is there, so retire the indicator.
            stopTyping(chatId);
        }
    };

    return {
        onUpdate: (connection, update) => {
            const message = update.message ?? update.channel_post;
            if (message === undefined) {
                return;
            }
            void onMessage(connection, message).catch((error: unknown) => ctx.log.error({ err: error }, "telegram update dispatch failed"));
        },
        stopAll: () => {
            for (const timer of typing.values()) {
                clearInterval(timer);
            }
            typing.clear();
        },
    };
};

// Telegram reports "nothing changed" as a 400 on editMessageText. The paint it refused was a no-op by
// definition, so treating it as one is the correct reading, not a swallowed error.
const isUnchangedEdit = (error: unknown): boolean => error instanceof TelegramApiError && error.description.includes("message is not modified");

// A 429 carries `retry_after` seconds, which the client puts on the error. Ignore an unreasonably long one —
// past that the turn is over and a late reply is worse than none.
const rateLimitWaitOf = (error: unknown): number | undefined => {
    const wait = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
    return wait !== undefined && wait > 0 && wait <= RATE_LIMIT_MAX_WAIT_MS ? wait : undefined;
};
