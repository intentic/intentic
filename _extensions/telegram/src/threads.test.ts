import type { TelegramMessage } from "./client.js";
import { decodeThread, encodeThread, routeOf, type StoredThreads, THREAD_MEMORY_MAX, threadMemory } from "./threads.js";

// Where a Telegram message's conversation lives: a private chat, or a request's reply chain in a group.

const ours = { usernames: new Set(["acme_bot"]), selfIds: new Set([777]) };
const group = { id: -100123, type: "supergroup", title: "eng" };

const message = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({ message_id: 11, chat: group, date: 0, from: { id: 42 }, text: "hi", ...over });

test("a thread id carries its root and, in a forum, its topic, and reads back the same", () => {
    expect(encodeThread({ root: 11 })).toBe("11");
    expect(encodeThread({ root: 11, topic: 5 })).toBe("5/11");
    expect(decodeThread("5/11")).toEqual({ root: 11, topic: 5 });
    expect(decodeThread("11")).toEqual({ root: 11 });
    expect(decodeThread("C1/11")).toBeUndefined();
});

test("a private chat is one conversation, always addressed", () => {
    expect(routeOf(message({ chat: { id: 42, type: "private" } }), ours, threadMemory())).toEqual({ addressed: true });
});

test("in a group a mention roots a chain at itself, inside its forum topic, and points replies at itself", () => {
    expect(routeOf(message({ text: "@acme_bot look" }), ours, threadMemory())).toEqual({ addressed: true, thread: "11", anchor: 11 });
    expect(routeOf(message({ text: "@acme_bot look", message_thread_id: 5, is_topic_message: true }), ours, threadMemory())).toEqual({
        addressed: true,
        thread: "5/11",
        anchor: 11,
        topic: 5,
    });
    // A plain message in the group is not for us, and belongs to no thread.
    expect(routeOf(message(), ours, threadMemory())).toEqual({ addressed: false, anchor: 11 });
});

test("a reply into a remembered chain joins it without a mention; one to a forgotten post of ours roots there", () => {
    const memory = threadMemory();
    memory.remember(String(group.id), 30, "20");
    const reply = (to: Partial<TelegramMessage>) => message({ message_id: 31, reply_to_message: message({ message_id: 30, ...to }) });
    expect(routeOf(reply({}), ours, memory)).toMatchObject({ addressed: true, thread: "20" });
    const forgotten = message({ message_id: 41, reply_to_message: message({ message_id: 40, from: { id: 777, is_bot: true } }) });
    expect(routeOf(forgotten, ours, memory)).toMatchObject({ addressed: true, thread: "40" });
});

test("the memory keeps the most recent messages, and what was stored before the process started", async () => {
    let stored: StoredThreads = { "-1:1": "1" };
    const document = {
        read: async () => stored,
        update: async (change: (current: StoredThreads) => StoredThreads) => {
            stored = change(stored);
            return stored;
        },
    };
    const memory = threadMemory(document);
    memory.remember("-1", 2, "1");
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.threadOf("-1", 1)).toBe("1");
    expect(memory.threadOf("-1", 2)).toBe("1");
    const bounded = threadMemory();
    for (let id = 0; id <= THREAD_MEMORY_MAX; id += 1) {
        bounded.remember("-1", id, "x");
    }
    expect(bounded.threadOf("-1", 0)).toBeUndefined();
    expect(bounded.threadOf("-1", THREAD_MEMORY_MAX)).toBe("x");
});
