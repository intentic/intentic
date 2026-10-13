import { sleep } from "@intentic/base/async";
import {
    type ChatReply,
    type ChatReplyDeps,
    type ChatSurface,
    createChatReply,
    type Logger,
    MESSAGE_LIMITS,
    type ProgressDetail,
    type ReplyMark,
    type ReplyRegistry,
    type ReplyTiming,
    tablesToCode,
} from "@intentic/connector-runtime";
import { renderCard, type StopData, type TelegramCardBody } from "./card.js";
import { TelegramApiError, type TelegramConnection } from "./client.js";
import { escapeHtml, toTelegramHtml } from "./format.js";
import type { TelegramRoute } from "./threads.js";

// One addressed message's answer in Telegram. What happens when (the mark the moment it is heard, the status card once
// the work outlasts a quick answer, narration on the card and the answer below it, how it ended) is the shared chat
// reply (connector-runtime's createChatReply), the same as Discord's and Slack's; this file is what it looks like in
// Telegram: a reaction from the few Telegram lets a bot use, "typing…", the card as an HTML message with buttons, and
// the answer's Markdown rendered as Telegram's HTML. In a group every message points at the one it answers, and stays in
// its forum topic.

const TELEGRAM_MAX = MESSAGE_LIMITS.telegram;
// Telegram drops "typing…" after about five seconds.
const TYPING_EVERY_MS = 4_000;
// A 429 is Telegram asking us to slow down, not to stop: worth one patient retry, but not past this, since a late reply
// is worse than none.
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

// Telegram lets a bot react only with emoji from a fixed list (no ✅ or ❌ among them), and only one at a time.
export const REACTIONS = { heard: "👀", done: "👌", failed: "😢", held: "🙏", queued: "🥱", stopped: "🫡" } as const satisfies Record<ReplyMark, string>;

// The reaction each message shows now, by "<chat>:<message>". Setting one replaces the last, so taking a mark off clears
// the message only when that mark is still the one showing.
export type ShownReactions = Map<string, string>;

export interface TelegramReplyDeps {
    readonly connection: TelegramConnection;
    readonly log: Logger;
    readonly detail: ProgressDetail;
    readonly registry: ReplyRegistry;
    readonly shown: ShownReactions;
    readonly stopData: StopData;
    // Each message the reply posted, with its words (none for the card), for the thread memory and the history ring.
    readonly posted: (messageId: number, text: string | undefined) => void;
    readonly timing?: ReplyTiming;
}

export interface TelegramReplyTarget {
    readonly chatId: number;
    readonly messageId: number;
    readonly route: TelegramRoute;
    // Who asked, named in the answer to a long-running request so they hear it finished.
    readonly asker: { readonly id: number; readonly name: string };
    readonly place: string;
    readonly onTaken: () => void;
}

const unchanged = (error: Error): boolean => error instanceof TelegramApiError && error.description.includes("message is not modified");
const unparsable = (error: Error): boolean => error instanceof TelegramApiError && error.description.includes("can't parse entities");
// A chat that allows no reactions, or not this one: the answer still arrives, without the mark.
const reactionRefused = (error: Error): boolean => error instanceof TelegramApiError && /REACTION_INVALID|REACTIONS_TOO_MANY|reactions are disabled/i.test(error.description);

const rateLimitWaitOf = (error: Error): number | undefined => {
    const wait = error instanceof TelegramApiError ? error.retryAfterMs : undefined;
    return wait !== undefined && wait > 0 && wait <= RATE_LIMIT_MAX_WAIT_MS ? wait : undefined;
};

// A call that waits out one 429 before giving up.
export const patiently = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
        return await call();
    } catch (error) {
        const wait = error instanceof Error ? rateLimitWaitOf(error) : undefined;
        if (wait === undefined) {
            throw error;
        }
        await sleep(wait);
        return await call();
    }
};

// Where a message goes, in the Bot API's own words: the chat, its forum topic, and in a group the message it answers.
export interface SendTarget {
    readonly chat_id: number | string;
    readonly message_thread_id?: number;
    readonly reply_parameters?: { readonly message_id: number; readonly allow_sending_without_reply: boolean };
}

// What a message says: its text, how Telegram should read it, and the buttons under it.
export interface MessageContent {
    readonly text: string;
    readonly parse_mode?: "HTML";
    readonly link_preview_options?: { readonly is_disabled: boolean };
    readonly reply_markup?: TelegramCardBody["reply_markup"];
}

export const sendingTo = (chatId: number | string, route: Pick<TelegramRoute, "topic" | "anchor">): SendTarget => {
    let target: SendTarget = { chat_id: chatId };
    if (route.topic !== undefined) {
        target = { ...target, message_thread_id: route.topic };
    }
    if (route.anchor !== undefined) {
        target = { ...target, reply_parameters: { message_id: route.anchor, allow_sending_without_reply: true } };
    }
    return target;
};

export const createTelegramReply = (deps: TelegramReplyDeps, target: TelegramReplyTarget): ChatReply => {
    const { connection, shown } = deps;
    const { chatId, route, asker } = target;
    const to = sendingTo(chatId, route);
    const send = (content: MessageContent): Promise<{ message_id: number }> => patiently(() => connection.call<{ message_id: number }>("sendMessage", { ...to, ...content }));
    const react = async (messageId: string, emoji: string | undefined): Promise<void> => {
        await connection
            .call("setMessageReaction", { chat_id: chatId, message_id: Number(messageId), reaction: emoji === undefined ? [] : [{ type: "emoji", emoji }] })
            .catch((error: Error) => {
                if (!reactionRefused(error)) {
                    throw error;
                }
            });
    };
    const surface: ChatSurface<number> = {
        maxChars: TELEGRAM_MAX,
        mentionCost: asker.name.length + 1,
        format: tablesToCode,
        post: async (chunk, { mention }) => {
            const named = mention ? `<a href="tg://user?id=${asker.id}">${escapeHtml(asker.name)}</a> ` : "";
            const sent = await send({ text: `${named}${toTelegramHtml(chunk)}`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(
                (error: Error) => {
                    // Markup Telegram cannot read goes out as the words it was written in, rather than not at all.
                    if (!unparsable(error)) {
                        throw error;
                    }
                    return send({ text: mention ? `${asker.name} ${chunk}` : chunk });
                },
            );
            deps.posted(sent.message_id, chunk);
        },
        postCard: async (view) => {
            const sent = await send(renderCard(view, deps.stopData));
            deps.posted(sent.message_id, undefined);
            return sent.message_id;
        },
        editCard: async (messageId, view) => {
            await patiently(() => connection.call("editMessageText", { chat_id: chatId, message_id: messageId, ...renderCard(view, deps.stopData) })).catch(
                (error: Error) => {
                    if (!unchanged(error)) {
                        throw error;
                    }
                },
            );
        },
        mark: async (message, mark) => {
            await react(message.id, REACTIONS[mark]);
            shown.set(`${message.channelId}:${message.id}`, REACTIONS[mark]);
        },
        unmark: async (message, mark) => {
            const key = `${message.channelId}:${message.id}`;
            if (shown.get(key) !== REACTIONS[mark]) {
                return;
            }
            shown.delete(key);
            await react(message.id, undefined);
        },
        typing: {
            say: () => connection.call("sendChatAction", route.topic === undefined ? { chat_id: chatId, action: "typing" } : { chat_id: chatId, action: "typing", message_thread_id: route.topic }),
            everyMs: TYPING_EVERY_MS,
        },
    };
    const replyDeps: ChatReplyDeps<number> = { provider: "telegram", surface, log: deps.log, detail: deps.detail, registry: deps.registry };
    return createChatReply(deps.timing === undefined ? replyDeps : { ...replyDeps, timing: deps.timing }, {
        message: { channelId: String(chatId), id: String(target.messageId) },
        place: target.place,
        onTaken: target.onTaken,
    });
};
