import type { ConversationQueue } from "@intentic/sandbox-contract/schemas/agent";
import { shallowRef } from "vue";
import type { ChatMessage } from "../transcript/transcript";
import { SENDING_SEEN_MS, SendingList } from "./sendingWords";

// What stands as sending, against a queue and a transcript that are nothing but refs.
const listOf = () => {
    const queue = shallowRef<ConversationQueue | undefined>();
    const messages = shallowRef<readonly ChatMessage[]>([]);
    return { list: new SendingList({ queue, messages }), queue, messages };
};

afterEach(() => {
    jest.useRealTimers();
});

describe(`words on their way`, () => {
    it(`stands from the press, and goes when ended`, () => {
        const { list } = listOf();
        const key = list.begin(`ship it`, [{ name: `a.png`, path: `/x/a.png` }]);

        expect(list.shown.value.map(({ text, attachments }) => ({ text, attachments }))).toEqual([{ text: `ship it`, attachments: [`/x/a.png`] }]);
        list.end(key);
        expect(list.shown.value).toEqual([]);
    });

    it(`is not taken for a row before its id is named, nor for words still waiting to send`, () => {
        const { list, messages } = listOf();
        const key = list.begin(`ship it`, []);
        messages.value = [{ id: 1, role: `user`, text: `ship it`, messageId: `m1`, unsent: true }];

        expect(list.shown.value).toHaveLength(1);
        list.named(key, `m1`);
        expect(list.shown.value).toHaveLength(1);
        messages.value = [{ id: 1, role: `user`, text: `ship it`, messageId: `m1` }];
        expect(list.shown.value).toEqual([]);
    });

    it(`goes at once when taken words are already shown, and stays gone`, () => {
        const { list, queue } = listOf();
        const key = list.begin(`ship it`, []);
        list.named(key, `m1`);
        queue.value = { items: [{ id: `m1`, text: `ship it`, voice: `person`, revision: 1, queuedAt: 1 }], revision: 1 };

        list.taken(key);
        queue.value = undefined;

        expect(list.shown.value).toEqual([]);
    });

    it(`goes after a while when taken words are never shown here`, () => {
        jest.useFakeTimers();
        const { list } = listOf();
        const key = list.begin(`ship it`, []);
        list.named(key, `m1`);

        list.taken(key);
        jest.advanceTimersByTime(SENDING_SEEN_MS - 1);
        expect(list.shown.value).toHaveLength(1);
        jest.advanceTimersByTime(1);
        expect(list.shown.value).toEqual([]);
    });
});
