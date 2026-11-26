import { GatewayRefusal } from "@intentic/connector-runtime";
import type { Chat } from "../server/chats.js";
import { fileOutbox } from "../server/outbox.js";
import { deliverToOutbox } from "./deliver.js";

// A late reply's way into a visitor's outbox: by the chat its conversation's thread names, or for a conversation the
// daemon opened before the move, by what the outbox already holds for it, else the only chat there is.

type OutboxFile = Parameters<Parameters<Parameters<typeof fileOutbox>[0][`update`]>[0]>[0];

const memoryOutbox = (initial: OutboxFile = {}) => {
    let stored = initial;
    const outbox = fileOutbox({
        read: async () => stored,
        update: async (change) => {
            stored = change(stored);
            return stored;
        },
    });
    return { outbox, stored: () => stored };
};

const chat = (id: string): Chat => ({ id, enabled: true, allowedOrigins: [], config: {} });
const NOW = 1_700_000_000_000;

test(`a reply goes to the outbox of the chat its thread names`, async () => {
    const { outbox, stored } = memoryOutbox();
    await deliverToOutbox(outbox, { list: async () => [chat(`a`), chat(`b`)] }, () => NOW)(`visitor-1`, `Here you go`, `b.3`);
    expect(stored()).toEqual({ "webchat:b:visitor-1": { lastAt: NOW, nextSeq: 2, entries: [{ seq: 1, at: NOW, text: `Here you go` }] } });
});

test(`a conversation from before the move finds its chat by the replies already waiting, else the only chat`, async () => {
    const waiting = memoryOutbox({ "webchat:b:visitor-1": { lastAt: NOW, nextSeq: 2, entries: [{ seq: 1, at: NOW, text: `earlier` }] } });
    await deliverToOutbox(waiting.outbox, { list: async () => [chat(`a`), chat(`b`)] }, () => NOW)(`visitor-1`, `later`);
    expect(waiting.stored()[`webchat:b:visitor-1`]?.entries.map((entry) => entry.text)).toEqual([`earlier`, `later`]);

    const only = memoryOutbox();
    await deliverToOutbox(only.outbox, { list: async () => [chat(`a`)] }, () => NOW)(`visitor-2`, `hello`);
    expect(Object.keys(only.stored())).toEqual([`webchat:a:visitor-2`]);

    const several = memoryOutbox();
    await expect(deliverToOutbox(several.outbox, { list: async () => [chat(`a`), chat(`b`)] }, () => NOW)(`visitor-3`, `hello`)).rejects.toBeInstanceOf(GatewayRefusal);
    expect(several.stored()).toEqual({});
});
