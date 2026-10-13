import { z } from "zod";
import type { TelegramMessage } from "./client.js";

// Where a Telegram message's conversation lives. A private chat is one conversation. In a group, Telegram has no threads
// a bot can open, so a request's thread is its reply chain: a mention starts one, rooted at the message that asked, and
// a reply to anything in it (the bot's card, its answer, a teammate's message there) continues it, no mention needed. A
// message names only the one message it replies to, never the chain's root, so the gateway remembers which chain every
// message it saw or posted belongs to, in a small file that survives a restart. In a forum supergroup the chain stays in
// its topic, which the thread id carries so a reply between turns lands there too.

// A thread as the daemon keys it: the chain's root message, and its forum topic when it has one ("<topic>/<root>").
export interface ThreadPlace {
    readonly root: number;
    readonly topic?: number;
}

export const encodeThread = (place: ThreadPlace): string => (place.topic === undefined ? String(place.root) : `${place.topic}/${place.root}`);

export const decodeThread = (thread: string): ThreadPlace | undefined => {
    const match = /^(?:(\d+)\/)?(\d+)$/.exec(thread);
    if (match === null) {
        return undefined;
    }
    const root = Number(match[2]);
    return match[1] === undefined ? { root } : { root, topic: Number(match[1]) };
};

// Which chain each message belongs to, by chat and message id, the most recent kept.
export interface ThreadMemory {
    readonly threadOf: (chatId: string, messageId: number) => string | undefined;
    readonly remember: (chatId: string, messageId: number, thread: string) => void;
}

export const THREAD_MEMORY_MAX = 5_000;
// How long a burst of remembered messages waits before it is written down, so a long answer is one write.
const SAVE_AFTER_MS = 2_000;

// The memory as stored: message key to thread.
export const StoredThreadsSchema = z.record(z.string(), z.string());
export type StoredThreads = z.infer<typeof StoredThreadsSchema>;

// The slice of the extension api's JSON document the memory writes through (`ctx.api.document`).
export interface ThreadsDocument {
    readonly read: () => Promise<StoredThreads>;
    readonly update: (change: (current: StoredThreads) => StoredThreads) => Promise<StoredThreads>;
}

// The memory, kept in the process and, given a document, written there and read back at start.
export const threadMemory = (document?: ThreadsDocument, onError: (error: Error) => void = () => {}): ThreadMemory => {
    const entries = new Map<string, string>();
    const keyOf = (chatId: string, messageId: number): string => `${chatId}:${messageId}`;
    const put = (key: string, thread: string): void => {
        entries.delete(key);
        entries.set(key, thread);
        const oldest = entries.size > THREAD_MEMORY_MAX ? entries.keys().next().value : undefined;
        if (oldest !== undefined) {
            entries.delete(oldest);
        }
    };
    let saving: ReturnType<typeof setTimeout> | undefined;
    const save = (): void => {
        if (document === undefined || saving !== undefined) {
            return;
        }
        saving = setTimeout(() => {
            saving = undefined;
            document.update(() => Object.fromEntries(entries)).catch(onError);
        }, SAVE_AFTER_MS);
        saving.unref();
    };
    // What was written before this process started goes under anything it has learned since.
    void document
        ?.read()
        .then((stored) => {
            const learned = [...entries];
            entries.clear();
            for (const [key, thread] of [...Object.entries(stored), ...learned]) {
                put(key, thread);
            }
        })
        .catch(onError);
    return {
        threadOf: (chatId, messageId) => entries.get(keyOf(chatId, messageId)),
        remember: (chatId, messageId, thread) => {
            put(keyOf(chatId, messageId), thread);
            save();
        },
    };
};

// Where a message belongs and whether it is for us, decided before anything is dispatched.
export interface TelegramRoute {
    readonly addressed: boolean;
    // The conversation's thread inside the chat (absent: the chat itself is the conversation).
    readonly thread?: string;
    // The forum topic replies go into.
    readonly topic?: number;
    // The message a reply in a group points at.
    readonly anchor?: number;
}

export interface OurBots {
    readonly usernames: ReadonlySet<string>;
    readonly selfIds: ReadonlySet<number>;
}

// Addressed to one of our bots: `@thebot` anywhere in text/caption (case-insensitive; `/cmd@thebot` counts too), or a
// reply to one of our posts. Private chats are always addressed, decided by the caller.
export const addressesUs = (message: TelegramMessage, usernames: ReadonlySet<string>, selfIds: ReadonlySet<number>): boolean => {
    const written = `${message.text ?? ""} ${message.caption ?? ""}`.toLowerCase();
    if ([...usernames].some((username) => written.includes(`@${username.toLowerCase()}`))) {
        return true;
    }
    const repliedTo = message.reply_to_message?.from;
    return repliedTo !== undefined && selfIds.has(repliedTo.id);
};

export const routeOf = (message: TelegramMessage, ours: OurBots, memory: Pick<ThreadMemory, "threadOf">): TelegramRoute => {
    if (message.chat.type === "private") {
        return { addressed: true };
    }
    const chatId = String(message.chat.id);
    const topic = message.is_topic_message === true ? message.message_thread_id : undefined;
    const replied = message.reply_to_message;
    // A reply into a chain we answer in belongs to that chain, mention or not.
    const known = replied === undefined ? undefined : memory.threadOf(chatId, replied.message_id);
    const mentioned = addressesUs(message, ours.usernames, ours.selfIds);
    const place: TelegramRoute = topic === undefined ? { addressed: false, anchor: message.message_id } : { addressed: false, anchor: message.message_id, topic };
    if (known !== undefined) {
        return { ...place, addressed: true, thread: known };
    }
    if (!mentioned) {
        return place;
    }
    // A reply to one of our posts whose chain was forgotten roots a new chain at that post; anything else at itself.
    const repliedOurs = replied?.from !== undefined && ours.selfIds.has(replied.from.id);
    const root = repliedOurs && replied !== undefined ? replied.message_id : message.message_id;
    return { ...place, addressed: true, thread: encodeThread(topic === undefined ? { root } : { root, topic }) };
};
