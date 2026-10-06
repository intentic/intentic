import { sleep } from "@intentic/base/async";
import {
    chatRings,
    deliverChunked,
    type GatewayCtx,
    GatewayRefusal,
    HISTORY_LIMIT,
    type ListenerHistoryEntry,
    type ListenerMessage,
    MESSAGE_LIMITS,
    paintReply,
    recentKeys,
    type StreamPoster,
    typingHeartbeat,
} from "@intentic/connector-runtime";
import { type TelegramConnection, TelegramApiError, type TelegramMessage, type TelegramUpdate } from "./client.js";

// Inbound half of the gateway: every update becomes a normalized message posted to the daemon's dispatch route; on a
// mention, holds the stream and paints the reply live, with "typing…" as the "I'm on it" signal. Telegram gives bots no
// history API, so context is a per-chat ring of what this process itself watched go by, empty after a restart. The Bot
// API never sends a bot its own messages back as updates, so what we post (a painted reply, a delivered message) goes
// into the ring as it is posted, marked `self`, the way Discord's and Slack's history APIs and WhatsApp's store already
// hold ours.

// Telegram rejects sendMessage over its limit outright; a longer reply spills into follow-up messages.
const TELEGRAM_MAX = MESSAGE_LIMITS.telegram;
// Min gap between edits; Telegram's per-chat rate budget counts edits too, so this is slower than Slack's.
const EDIT_INTERVAL_MS = 2_500;
// How many chats we keep history rings for.
const HISTORY_CHATS_MAX = 200;
// Typing action expires after ~5s; re-sent on this cadence.
const TYPING_INTERVAL_MS = 4_000;
// A 429 during a paint is Telegram asking us to slow down, not to stop, the reply is worth one patient retry.
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

// Best available name for the author: display name if set, else @username; an anonymous channel post has neither, so
// falls back to "channel".
export const authorNameOf = (message: TelegramMessage): string => {
    const from = message.from;
    if (from === undefined) {
        return message.chat.title ?? "channel";
    }
    const full = [from.first_name, from.last_name].filter((part) => part !== undefined && part !== "").join(" ");
    return full !== "" ? full : (from.username ?? String(from.id));
};

// Describes the message when it carries no words (e.g. a captionless photo), so it reads as "sent a photo" rather than
// nothing; the file itself is in `extra.attachments`.
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

// Every file the message carries as name + file_id; the id is what `getFile` takes to download it.
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

// Addressed to one of our bots: `@thebot` anywhere in text/caption (case-insensitive; `/cmd@thebot` counts too), or a
// reply to one of our posts. Private chats are handled by the caller instead.
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
    // Posts into a chat outside any live turn (the daemon's speak-as-the-agent path), through the first bot that takes
    // it; the next is tried only if nothing posted yet, so a partial spill is never duplicated.
    readonly deliver: (chatId: string, text: string) => Promise<void>;
    readonly stopAll: () => void;
}

export const createTelegramListener = (ctx: GatewayCtx, connections: () => ReadonlyMap<string, TelegramConnection>): TelegramListener => {
    const recent = recentKeys();
    // Stand-in for a history API: what this process has watched go by, and what it posted itself, per chat.
    const seen = chatRings<ListenerHistoryEntry>({ perChat: HISTORY_LIMIT, chats: HISTORY_CHATS_MAX });
    // Live "typing…" indicators keyed by chatId, started on a mention, cleared when the turn ends.
    const typing = typingHeartbeat({ intervalMs: TYPING_INTERVAL_MS });

    // One of our own posts, as the ring holds it. The entry is returned so a reply that grows by edits can keep it
    // reading as the chat does.
    const rememberOwn = (connection: TelegramConnection, chatId: string, content: string): ListenerHistoryEntry => {
        const entry: ListenerHistoryEntry = {
            author: { id: String(connection.selfId), name: connection.username },
            content,
            timestamp: new Date().toISOString(),
            self: true,
        };
        seen.remember(chatId, entry);
        return entry;
    };

    const startTyping = (connection: TelegramConnection, message: TelegramMessage): void => {
        const action = {
            chat_id: message.chat.id,
            action: "typing",
            ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }),
        };
        typing.start(String(message.chat.id), () => void connection.call("sendChatAction", action).catch(() => undefined));
    };

    // The two Bot API calls the painter makes; folds in two non-failures: an unchanged edit (400) is a no-op, and a 429
    // gets one patient wait. Anything else reaches the painter, which kills the stream rather than post a half reply.
    const posterFor = (connection: TelegramConnection, message: TelegramMessage): StreamPoster<number> => {
        const chatId = String(message.chat.id);
        // What each message we posted for this reply says now, so an edit updates its history entry in place.
        const posted = new Map<number, ListenerHistoryEntry>();
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
                await sleep(wait);
                return await call();
            }
        };
        return {
            post: async (text) => {
                const sent = await patient(() => connection.call<{ message_id: number }>("sendMessage", { ...base, text }));
                posted.set(sent.message_id, rememberOwn(connection, chatId, text));
                return sent.message_id;
            },
            update: async (messageId, text) => {
                await patient(() => connection.call("editMessageText", { chat_id: message.chat.id, message_id: messageId, text })).catch(
                    (error: unknown) => {
                        if (!isUnchangedEdit(error)) {
                            throw error;
                        }
                    },
                );
                const entry = posted.get(messageId);
                if (entry !== undefined) {
                    entry.content = text;
                }
            },
        };
    };

    const onMessage = async (connection: TelegramConnection, message: TelegramMessage): Promise<void> => {
        const chatId = String(message.chat.id);
        const key = `${chatId}:${message.message_id}`;
        if (recent.duplicate(key)) {
            return;
        }
        const live = [...connections().values()];
        const selfIds = new Set(live.map((each) => each.selfId));
        // Insurance, not a filter: Telegram never cross-delivers messages, but self-wake is what this guards against.
        if (message.from !== undefined && selfIds.has(message.from.id)) {
            return;
        }

        const content = contentOf(message);
        const timestamp = new Date(message.date * 1_000).toISOString();
        const author = { id: String(message.from?.id ?? message.chat.id), name: authorNameOf(message) };
        // Goes into the ring regardless of whether it wakes anything; it's context for the next mention.
        const history = seen.of(chatId);
        seen.remember(chatId, { author, content, timestamp });

        const usernames = new Set(live.map((each) => each.username));
        const mentioned = message.chat.type === "private" || addressesUs(message, usernames, selfIds);
        const attachments = attachmentsOf(message);
        const payload: ListenerMessage = {
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
        await paintReply(ctx.daemon, payload, {
            surface: { stream: posterFor(connection, message), editIntervalMs: EDIT_INTERVAL_MS },
            maxChars: TELEGRAM_MAX,
            onError: (error) => ctx.log.warn({ err: error }, "telegram stream paint failed"),
            // The turn(s) ended (or the stream broke), the reply is there, so retire the indicator.
            settle: () => typing.stop(chatId),
        });
    };

    return {
        deliver: async (chatId, text) => {
            await deliverChunked(
                connections().values(),
                async (connection, chunk) => {
                    await connection.call("sendMessage", { chat_id: chatId, text: chunk });
                    rememberOwn(connection, chatId, chunk);
                },
                text,
                TELEGRAM_MAX,
                () => new GatewayRefusal("no Telegram bot is connected"),
            );
        },
        onUpdate: (connection, update) => {
            const message = update.message ?? update.channel_post;
            if (message === undefined) {
                return;
            }
            void onMessage(connection, message).catch((error: unknown) => ctx.log.error({ err: error }, "telegram update dispatch failed"));
        },
        stopAll: typing.stopAll,
    };
};

// Telegram reports a no-op edit as a 400 on editMessageText; treating it as a no-op is correct, not a swallowed error.
const isUnchangedEdit = (error: unknown): boolean => error instanceof TelegramApiError && error.description.includes("message is not modified");

// A 429's `retry_after` rides the error; ignored past a ceiling, since a late reply then is worse than none.
const rateLimitWaitOf = (error: unknown): number | undefined => {
    const wait = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
    return wait !== undefined && wait > 0 && wait <= RATE_LIMIT_MAX_WAIT_MS ? wait : undefined;
};
