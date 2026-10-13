import {
    chatRings,
    type ChatReply,
    deliverChunked,
    type GatewayCtx,
    GatewayRefusal,
    HISTORY_LIMIT,
    type ListenerHistoryEntry,
    type ListenerMessage,
    MESSAGE_LIMITS,
    progressDetailOf,
    recentKeys,
    type ReplyTiming,
    runRegistry,
    stopFromChat,
    tablesToCode,
} from "@intentic/connector-runtime";
import type { TelegramCallbackQuery, TelegramConnection, TelegramMemberUpdate, TelegramMessage, TelegramUpdate, TelegramUser } from "./client.js";
import { toTelegramHtml } from "./format.js";
import { createTelegramReply, patiently, type SendTarget, sendingTo, type ShownReactions, type TelegramReplyDeps } from "./reply.js";
import { decodeThread, routeOf, type TelegramRoute, type ThreadMemory, threadMemory } from "./threads.js";

export { addressesUs } from "./threads.js";

// Inbound half of the gateway: every update becomes a normalized message posted to the daemon's dispatch route. A message
// addressed to us (a private message, an @mention, a reply to the bot, or anything in a reply chain it answers in) gets
// its answer back through the shared chat reply (reply.ts): 👀 at once, a status card with Stop once the work outlasts
// a quick answer, the answer below it, and a reaction for how it ended. Each request's reply chain in a group is its own
// conversation (threads.ts). The card's Stop comes back here as a button press.
//
// Telegram gives bots no history API, so context is a per-chat ring of what this process itself watched go by, empty
// after a restart. The Bot API never sends a bot its own messages back as updates, so what we post (an answer, a
// delivered message) goes into the ring as it is posted, marked `self`, the way Discord's and Slack's history APIs and
// WhatsApp's store already hold ours.

// Telegram rejects sendMessage over its limit outright; a longer reply spills into follow-up messages.
const TELEGRAM_MAX = MESSAGE_LIMITS.telegram;
// How many chats we keep history rings for.
const HISTORY_CHATS_MAX = 200;
// Stop buttons whose conversation the gateway still remembers; older ones answer that the work already finished.
const STOP_TOKENS_MAX = 500;

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

export interface TelegramListener {
    readonly onUpdate: (connection: TelegramConnection, update: TelegramUpdate) => void;
    // Posts into a chat outside any live turn (the daemon's speak-as-the-agent path), into the conversation's reply chain
    // when it lives in one, through the first bot that takes it; the next is tried only if nothing posted yet, so a
    // partial spill is never duplicated.
    readonly deliver: (chatId: string, text: string, thread?: string) => Promise<void>;
}

// What the listener reads of a bot's connector, and where it keeps its thread memory (in the process alone when absent).
export interface TelegramListenerOptions {
    readonly progressOf?: (connection: TelegramConnection) => string | undefined;
    readonly threads?: ThreadMemory;
    readonly timing?: ReplyTiming;
}

const nameOf = (user: TelegramUser): string => {
    const full = [user.first_name, user.last_name].filter((part) => part !== undefined && part !== "").join(" ");
    return full !== "" ? full : (user.username ?? String(user.id));
};

export const welcomeText = (username: string): string =>
    [
        "👋 Hi! I'm the agent from this team's Intentic sandbox.",
        `Mention @${username} with a question or a task: I answer right here, show what I'm doing while I work, and anyone can steer me by replying to my messages, no mention needed.`,
    ].join("\n");

// Statuses a bot is in a chat with; a change from outside them into them is the bot being added.
const PRESENT = new Set(["member", "administrator", "creator"]);

// What a Telegram message carries beyond the common fields: the kind of chat, the message's own id (what a reply or a
// reaction names), the group's title, its forum topic, and the files attached.
type TelegramExtra = {
    chatType: string;
    messageId: number;
    chatTitle?: string;
    messageThreadId?: number;
    attachments?: ReadonlyArray<{ name: string; fileId: string }>;
};

// The normalized message the daemon dispatches on.
export const payloadOf = (message: TelegramMessage, route: TelegramRoute, history: readonly ListenerHistoryEntry[]): ListenerMessage => {
    const attachments = attachmentsOf(message);
    const extra: TelegramExtra = { chatType: message.chat.type, messageId: message.message_id };
    if (message.chat.title !== undefined) {
        extra.chatTitle = message.chat.title;
    }
    if (message.message_thread_id !== undefined) {
        extra.messageThreadId = message.message_thread_id;
    }
    if (attachments.length > 0) {
        extra.attachments = attachments;
    }
    let payload: ListenerMessage = {
        provider: "telegram",
        type: "message",
        id: String(message.message_id),
        channelId: String(message.chat.id),
        author: { id: String(message.from?.id ?? message.chat.id), name: authorNameOf(message) },
        content: contentOf(message),
        timestamp: new Date(message.date * 1_000).toISOString(),
        extra,
    };
    if (route.addressed) {
        payload = { ...payload, mentioned: true };
    }
    if (route.thread !== undefined) {
        payload = { ...payload, thread: route.thread };
    }
    if (history.length > 0) {
        payload = { ...payload, history: [...history] };
    }
    return payload;
};

export const createTelegramListener = (
    ctx: GatewayCtx,
    connections: () => ReadonlyMap<string, TelegramConnection>,
    options: TelegramListenerOptions = {},
): TelegramListener => {
    const recent = recentKeys();
    // Stand-in for a history API: what this process has watched go by, and what it posted itself, per chat.
    const seen = chatRings<ListenerHistoryEntry>({ perChat: HISTORY_LIMIT, chats: HISTORY_CHATS_MAX });
    const threads = options.threads ?? threadMemory();
    const runs = runRegistry();
    const shown: ShownReactions = new Map();
    // A Stop button carries a short token (Telegram caps a button's data at 64 bytes); the conversation is kept here.
    const stops = new Map<string, string>();
    let stopSeq = 0;
    const stopData = (conversationId: string): string => {
        const known = [...stops].find(([, id]) => id === conversationId)?.[0];
        if (known !== undefined) {
            return `stop:${known}`;
        }
        stopSeq += 1;
        const token = stopSeq.toString(36);
        stops.set(token, conversationId);
        const oldest = stops.size > STOP_TOKENS_MAX ? stops.keys().next().value : undefined;
        if (oldest !== undefined) {
            stops.delete(oldest);
        }
        return `stop:${token}`;
    };

    // One of our own posts, as the ring holds it.
    const rememberOwn = (connection: TelegramConnection, chatId: string, content: string): void => {
        seen.remember(chatId, {
            author: { id: String(connection.selfId), name: connection.username },
            content,
            timestamp: new Date().toISOString(),
            self: true,
        });
    };

    const replyFor = (connection: TelegramConnection, message: TelegramMessage, route: TelegramRoute): ChatReply => {
        const chatId = String(message.chat.id);
        const { thread } = route;
        const deps: TelegramReplyDeps = {
            connection,
            log: ctx.log,
            detail: progressDetailOf(options.progressOf?.(connection)),
            registry: runs,
            shown,
            stopData,
            posted: (messageId, text) => {
                if (thread !== undefined) {
                    threads.remember(chatId, messageId, thread);
                }
                if (text !== undefined) {
                    rememberOwn(connection, chatId, text);
                }
            },
        };
        return createTelegramReply(options.timing === undefined ? deps : { ...deps, timing: options.timing }, {
            chatId: message.chat.id,
            messageId: message.message_id,
            route,
            asker: { id: message.from?.id ?? message.chat.id, name: authorNameOf(message) },
            place: `${chatId}/${thread ?? ""}`,
            // Once something answers it, the message is part of its chain: a reply to it continues the conversation.
            onTaken: () => {
                if (thread !== undefined) {
                    threads.remember(chatId, message.message_id, thread);
                }
            },
        });
    };

    const onMessage = async (connection: TelegramConnection, message: TelegramMessage): Promise<void> => {
        const chatId = String(message.chat.id);
        if (recent.duplicate(`${chatId}:${message.message_id}`)) {
            return;
        }
        const live = [...connections().values()];
        const selfIds = new Set(live.map((each) => each.selfId));
        // Insurance, not a filter: Telegram never cross-delivers messages, but self-wake is what this guards against.
        if (message.from !== undefined && selfIds.has(message.from.id)) {
            return;
        }
        // Goes into the ring regardless of whether it wakes anything; it's context for the next mention.
        const history = seen.of(chatId);
        seen.remember(chatId, {
            author: { id: String(message.from?.id ?? message.chat.id), name: authorNameOf(message) },
            content: contentOf(message),
            timestamp: new Date(message.date * 1_000).toISOString(),
        });
        const route = routeOf(message, { usernames: new Set(live.map((each) => each.username)), selfIds }, threads);
        const payload = payloadOf(message, route, history);
        if (!route.addressed) {
            await ctx.daemon.dispatch(payload);
            return;
        }
        // Heard at once, before the (debounced) turn spins up: the reply reacts 👀 and says "typing…" as it is made.
        const reply = replyFor(connection, message, route);
        try {
            await ctx.daemon.dispatchStreaming(payload, reply.frame);
        } finally {
            await reply.settle();
        }
    };

    // A status card's Stop: the daemon decides whether the presser may, by the automation's own sender rules, and only
    // the presser is told how it went.
    const onCallback = async (connection: TelegramConnection, query: TelegramCallbackQuery): Promise<void> => {
        const data = query.data ?? "";
        if (!data.startsWith("stop:")) {
            return;
        }
        const conversationId = stops.get(data.slice("stop:".length));
        const shownAs = nameOf(query.from);
        const text =
            conversationId === undefined
                ? "That one has already finished."
                : await stopFromChat(ctx.daemon, runs, { conversationId, author: { id: String(query.from.id), name: shownAs } }, shownAs, ctx.log);
        await connection.call("answerCallbackQuery", { callback_query_id: query.id, text });
    };

    // Added to a group while the assistant is on: say hello there, so people know how to reach it.
    const onMembership = async (connection: TelegramConnection, change: TelegramMemberUpdate): Promise<void> => {
        const added = !PRESENT.has(change.old_chat_member.status) && PRESENT.has(change.new_chat_member.status);
        if (!added || change.new_chat_member.user.id !== connection.selfId || change.chat.type === "private" || change.chat.type === "channel") {
            return;
        }
        if (recent.duplicate(`joined:${change.chat.id}`)) {
            return;
        }
        const text = welcomeText(connection.username);
        await connection.call("sendMessage", { chat_id: change.chat.id, text });
        rememberOwn(connection, String(change.chat.id), text);
    };

    // One delivered chunk: Markdown as Telegram's HTML, or as the words it was written in when Telegram cannot read it.
    const sendChunk = async (connection: TelegramConnection, to: SendTarget, chunk: string): Promise<{ message_id: number }> =>
        patiently(() => connection.call<{ message_id: number }>("sendMessage", { ...to, text: toTelegramHtml(chunk), parse_mode: "HTML", link_preview_options: { is_disabled: true } })).catch(
            (error: Error) => {
                if (!error.message.includes("can't parse entities")) {
                    throw error;
                }
                return connection.call<{ message_id: number }>("sendMessage", { ...to, text: chunk });
            },
        );

    return {
        deliver: async (chatId, text, thread) => {
            const place = thread === undefined ? undefined : decodeThread(thread);
            const to = sendingTo(chatId, { ...(place?.topic === undefined ? {} : { topic: place.topic }), ...(place === undefined ? {} : { anchor: place.root }) });
            await deliverChunked(
                connections().values(),
                async (connection, chunk) => {
                    const sent = await sendChunk(connection, to, chunk);
                    rememberOwn(connection, chatId, chunk);
                    if (thread !== undefined) {
                        threads.remember(chatId, sent.message_id, thread);
                    }
                },
                tablesToCode(text),
                TELEGRAM_MAX,
                () => new GatewayRefusal("no Telegram bot is connected"),
            );
        },
        onUpdate: (connection, update) => {
            const failed = (what: string) => (error: Error) => ctx.log.error({ err: error }, `telegram ${what} failed`);
            if (update.callback_query !== undefined) {
                onCallback(connection, update.callback_query).catch(failed("stop"));
                return;
            }
            if (update.my_chat_member !== undefined) {
                onMembership(connection, update.my_chat_member).catch(failed("hello"));
                return;
            }
            const message = update.message ?? update.channel_post;
            if (message !== undefined) {
                onMessage(connection, message).catch(failed("update dispatch"));
            }
        },
    };
};
